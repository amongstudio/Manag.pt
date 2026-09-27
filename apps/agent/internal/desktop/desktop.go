//go:build !lite

package desktop

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/pc-manager/agent/internal/capture"
	"github.com/pc-manager/agent/internal/logger"
	"github.com/pc-manager/agent/internal/notify"
	"github.com/pc-manager/agent/internal/screenshot"
	"github.com/pc-manager/agent/internal/wsprotocol"
)

const (
	frameMagic     = "PCM1"
	fragSize       = 16 * 1024
	defaultFPS     = 5
	defaultQuality = 50
	highWater      = 512 * 1024
	midWater       = 256 * 1024
	clipCap        = 256 * 1024
	maxPendingICE  = 64
)

type IceServerJSON struct {
	URLs       json.RawMessage `json:"urls"`
	Username   string          `json:"username,omitempty"`
	Credential string          `json:"credential,omitempty"`
}

type SignalPayload struct {
	Kind       string          `json:"kind"`
	SDP        string          `json:"sdp,omitempty"`
	SDPType    string          `json:"sdpType,omitempty"`
	Candidate  any             `json:"candidate,omitempty"`
	AllowInput *bool           `json:"allowInput,omitempty"`
	Encrypted  bool            `json:"encrypted,omitempty"`
	IceServers []IceServerJSON `json:"iceServers,omitempty"`
	FPS        *float64        `json:"fps,omitempty"`
	Quality    *int            `json:"quality,omitempty"`
	Display    *int            `json:"display,omitempty"`
	MaxWidth   *int            `json:"maxWidth,omitempty"`
	Codec      string          `json:"codec,omitempty"`
	Audio      bool            `json:"audio,omitempty"`
	Error      string          `json:"error,omitempty"`
	Reason     string          `json:"reason,omitempty"`
}

type Sender func(payload SignalPayload)

type Session struct {
	log         *logger.AgentLog
	send        Sender
	stun        string
	ice         []webrtc.ICEServer
	mu          sync.Mutex
	encMu       sync.Mutex
	pc          *webrtc.PeerConnection
	desk        *webrtc.DataChannel
	input       *webrtc.DataChannel
	stop        chan struct{}
	allow       atomic.Bool
	width       int
	height      int
	frame       uint32
	fps         atomic.Int32
	quality     atomic.Int32
	display     atomic.Int32
	maxWidth    atomic.Int32
	bytesSent   atomic.Uint64
	framesSent  atomic.Uint32
	inputUnsup  atomic.Bool
	reqCodec    string
	reqAudio    bool
	activeCodec atomic.Value
	audioOn     atomic.Bool
	fallback    atomic.Value
	hung        atomic.Bool
	gotFrame    atomic.Bool
	videoTrack  *webrtc.TrackLocalStaticSample
	audioTrack  *webrtc.TrackLocalStaticSample
	h264        h264Encoder
	clipRing    *clipRing
	pendingICE  []webrtc.ICECandidateInit
	remoteReady bool
}

func New(log *logger.AgentLog, send Sender, stun string) *Session {
	if stun == "" {
		stun = wsprotocol.DefaultSTUN
	}
	s := &Session{log: log, send: send, stun: stun, clipRing: newClipRing(clipRingMax)}
	s.fps.Store(defaultFPS)
	s.quality.Store(defaultQuality)
	s.activeCodec.Store("jpeg")
	return s
}

func (s *Session) Handle(payload []byte) {
	var msg SignalPayload
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}
	switch msg.Kind {
	case "offer":
		notify.PostKind(notify.KindDesktopIncoming)
		s.allow.Store(msg.AllowInput != nil && *msg.AllowInput)
		s.applyCapture(msg.FPS, msg.Quality, msg.Display, msg.MaxWidth)
		s.storeICE(msg.IceServers)
		go s.startFromOffer(msg)
	case "ice":
		s.addICE(msg.Candidate)
	case "hangup":
		s.Close()
	case "control":
		if msg.AllowInput != nil {
			s.allow.Store(*msg.AllowInput)
		}
		s.applyCapture(msg.FPS, msg.Quality, msg.Display, msg.MaxWidth)
		s.storeICE(msg.IceServers)
	case "answer":
		s.setAnswer(msg)
	}
}

func (s *Session) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeLocked()
}

func (s *Session) closeLocked() {
	if s.stop != nil {
		select {
		case <-s.stop:
		default:
			close(s.stop)
		}
		s.stop = nil
	}
	s.encMu.Lock()
	if s.h264 != nil {
		s.h264.Close()
		s.h264 = nil
	}
	s.encMu.Unlock()
	releaseHeldInput()
	if s.pc != nil {
		_ = s.pc.Close()
		s.pc = nil
	}
	s.desk = nil
	s.input = nil
	s.videoTrack = nil
	s.audioTrack = nil
	s.pendingICE = nil
	s.remoteReady = false
}

func (s *Session) abort(code string) {
	s.abortPC(nil, code)
}

func (s *Session) abortPC(pc *webrtc.PeerConnection, code string) {
	if code == "" {
		code = "capture_failed"
	}
	if s.hung.CompareAndSwap(false, true) {
		s.send(SignalPayload{Kind: "hangup", Error: code, Reason: code})
	}
	if pc == nil {
		s.Close()
		return
	}
	s.mu.Lock()
	if s.pc == pc {
		s.closeLocked()
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	_ = pc.Close()
}

func (s *Session) startFromOffer(msg SignalPayload) {
	if strings.TrimSpace(msg.SDP) == "" {
		s.abort("webrtc_offer")
		return
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: s.iceServers()})
	if err != nil {
		s.log.Notef("WARNING", "webrtc pc: %v", err)
		s.abort("webrtc_pc")
		return
	}

	s.mu.Lock()
	pending := s.pendingICE
	s.closeLocked()
	s.pendingICE = pending
	s.pc = pc
	s.remoteReady = false
	s.stop = make(chan struct{})
	stop := s.stop
	s.reqCodec = "jpeg"
	s.reqAudio = msg.Audio
	s.audioOn.Store(false)
	s.fallback.Store("")
	s.activeCodec.Store("jpeg")
	s.hung.Store(false)
	s.gotFrame.Store(false)
	if strings.EqualFold(msg.Codec, "h264") {
		s.reqCodec = "h264"
	}
	s.mu.Unlock()

	if s.reqCodec == "h264" && h264Available() && strings.Contains(msg.SDP, "m=video") {
		if err := s.addVideoTrack(pc); err != nil {
			s.fallback.Store(err.Error())
			s.log.Notef("WARNING", "webrtc video track: %v", err)
		} else {
			s.activeCodec.Store("h264")
		}
	} else if s.reqCodec == "h264" {
		if !h264Available() {
			s.fallback.Store("h264 is Windows-only")
		} else {
			s.fallback.Store("offer has no video m-line")
		}
		s.activeCodec.Store("jpeg")
	}

	if s.reqAudio && audioAvailable() && strings.Contains(msg.SDP, "m=audio") {
		if err := s.addAudioTrack(pc, stop); err != nil {
			s.log.Notef("WARNING", "webrtc audio track: %v", err)
		}
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		s.send(SignalPayload{Kind: "ice", Candidate: c.ToJSON()})
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state != webrtc.PeerConnectionStateFailed && state != webrtc.PeerConnectionStateClosed {
			return
		}
		s.mu.Lock()
		still := s.pc == pc
		s.mu.Unlock()
		if still {
			go s.abortPC(pc, "webrtc_failed")
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		switch dc.Label() {
		case "desktop":
			s.mu.Lock()
			s.desk = dc
			stop := s.stop
			s.mu.Unlock()
			if stop == nil {
				return
			}
			dc.SetBufferedAmountLowThreshold(64 * 1024)
			dc.OnOpen(func() { go s.captureLoop(dc, stop) })
		case "input":
			s.mu.Lock()
			s.input = dc
			s.mu.Unlock()
			dc.OnMessage(func(m webrtc.DataChannelMessage) {
				s.handleInput(m.Data, func(resp []byte) {
					_ = dc.SendText(string(resp))
				})
			})
			dc.OnOpen(func() {
				s.sendClipList(dc)
			})
		}
	})
	offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: msg.SDP}
	if err := pc.SetRemoteDescription(offer); err != nil {
		s.log.Notef("WARNING", "webrtc remote: %v", err)
		s.abortPC(pc, "webrtc_remote")
		return
	}
	s.markRemoteReady(pc)
	s.mu.Lock()
	still := s.pc == pc
	s.mu.Unlock()
	if !still {
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		s.log.Notef("WARNING", "webrtc answer: %v", err)
		s.abortPC(pc, "webrtc_answer")
		return
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		s.log.Notef("WARNING", "webrtc local: %v", err)
		s.abortPC(pc, "webrtc_local")
		return
	}
	s.mu.Lock()
	still = s.pc == pc
	s.mu.Unlock()
	if !still {
		return
	}
	local := pc.LocalDescription()
	if local == nil || local.SDP == "" {
		s.abortPC(pc, "webrtc_answer")
		return
	}
	s.send(SignalPayload{Kind: "answer", SDP: local.SDP, SDPType: "answer"})
}

func (s *Session) addVideoTrack(pc *webrtc.PeerConnection) error {
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			ClockRate:   90000,
			SDPFmtpLine: h264SDPFmtpLine,
		},
		"video", "desktop",
	)
	if err != nil {
		return err
	}
	if _, err := pc.AddTrack(track); err != nil {
		return err
	}
	s.videoTrack = track
	return nil
}

func (s *Session) addAudioTrack(pc *webrtc.PeerConnection, stop <-chan struct{}) error {
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"},
		"audio", "desktop",
	)
	if err != nil {
		return err
	}
	if _, err := pc.AddTrack(track); err != nil {
		return err
	}
	s.audioTrack = track
	s.audioOn.Store(true)
	if err := startLoopbackAudio(track, stop, func(ok bool, reason string) {
		s.audioOn.Store(ok)
		if !ok {
			s.sendDeskJSON(map[string]any{"type": "codec", "codec": s.codecName(), "audio": false, "reason": reason})
		}
	}); err != nil {
		s.audioOn.Store(false)
		return err
	}
	return nil
}

func (s *Session) codecName() string {
	v, _ := s.activeCodec.Load().(string)
	if v == "" {
		return "jpeg"
	}
	return v
}

func (s *Session) fallbackReason() string {
	v, _ := s.fallback.Load().(string)
	return v
}

func (s *Session) sendDeskJSON(v any) {
	s.mu.Lock()
	dc := s.desk
	s.mu.Unlock()
	if dc == nil || dc.ReadyState() != webrtc.DataChannelStateOpen {
		return
	}
	msg, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = dc.SendText(string(msg))
}

func (s *Session) setAnswer(msg SignalPayload) {
	s.mu.Lock()
	pc := s.pc
	s.mu.Unlock()
	if pc == nil || msg.SDP == "" {
		return
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: msg.SDP}); err != nil {
		return
	}
	s.markRemoteReady(pc)
}

func parseICECandidate(candidate any) (webrtc.ICECandidateInit, bool) {
	if candidate == nil {
		return webrtc.ICECandidateInit{}, false
	}
	if text, ok := candidate.(string); ok {
		text = strings.TrimSpace(text)
		if text == "" {
			return webrtc.ICECandidateInit{}, false
		}
		return webrtc.ICECandidateInit{Candidate: text}, true
	}
	raw, err := json.Marshal(candidate)
	if err != nil {
		return webrtc.ICECandidateInit{}, false
	}
	var init webrtc.ICECandidateInit
	if err := json.Unmarshal(raw, &init); err != nil {
		return webrtc.ICECandidateInit{}, false
	}
	if strings.TrimSpace(init.Candidate) == "" && init.SDPMid == nil && init.SDPMLineIndex == nil {
		return webrtc.ICECandidateInit{}, false
	}
	return init, true
}

func (s *Session) addICE(candidate any) {
	init, ok := parseICECandidate(candidate)
	if !ok {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pc != nil && s.remoteReady {
		_ = s.pc.AddICECandidate(init)
		return
	}
	if len(s.pendingICE) >= maxPendingICE {
		s.pendingICE = s.pendingICE[1:]
	}
	s.pendingICE = append(s.pendingICE, init)
}

func (s *Session) markRemoteReady(pc *webrtc.PeerConnection) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pc != pc {
		return
	}
	s.remoteReady = true
	s.flushICELocked()
}

func (s *Session) flushICELocked() {
	if s.pc == nil || !s.remoteReady {
		return
	}
	for _, init := range s.pendingICE {
		_ = s.pc.AddICECandidate(init)
	}
	s.pendingICE = nil
}

func (s *Session) captureLoop(dc *webrtc.DataChannel, stop <-chan struct{}) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if s.reqCodec == "h264" && h264Available() {
		_ = initMediaRuntime()
		img, err := screenshot.CaptureImage(int(s.display.Load()), h264CaptureMaxWidth(int(s.maxWidth.Load())))
		if screenshot.IsNoInteractiveSession(err) {
			s.captureFailed(dc, err)
		}
		var encErr error
		if err == nil && img != nil {
			img = prepareH264Frame(img, int(s.maxWidth.Load()))
			encErr = s.ensureH264Encoder(img)
		}
		if err != nil || img == nil || encErr != nil {
			reason := h264FallbackReason(encErr, err)
			s.activeCodec.Store("jpeg")
			s.fallback.Store(reason)
		} else {
			s.activeCodec.Store("h264")
		}
	}
	s.sendHello(dc)
	if s.reqCodec == "h264" && s.codecName() == "jpeg" {
		msg, _ := json.Marshal(map[string]any{"type": "codec", "codec": "jpeg", "reason": s.fallbackReason()})
		_ = dc.SendText(string(msg))
	}
	go s.clipWatch(dc, stop)
	lastStats := time.Now()
	for {
		select {
		case <-stop:
			return
		default:
		}
		if dc.ReadyState() != webrtc.DataChannelStateOpen {
			return
		}
		s.maybeCapture(dc)
		if time.Since(lastStats) >= time.Second {
			s.sendStats(dc, time.Since(lastStats))
			lastStats = time.Now()
		}
		fps := s.fps.Load()
		if fps < 1 {
			fps = defaultFPS
		}
		timer := time.NewTimer(time.Second / time.Duration(fps))
		select {
		case <-stop:
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (s *Session) ensureH264Encoder(img image.Image) error {
	s.encMu.Lock()
	defer s.encMu.Unlock()
	return s.ensureH264EncoderLocked(img)
}

func (s *Session) ensureH264EncoderLocked(img image.Image) error {
	b := img.Bounds()
	w, h := evenSize(b.Dx()), evenSize(b.Dy())
	if w > maxH264Width {
		return errors.New(codeFrameTooLarge)
	}
	if s.h264 != nil {
		ew, eh := s.h264.Size()
		if ew == w && eh == h {
			return nil
		}
		s.h264.Close()
		s.h264 = nil
	}
	fps := int(s.fps.Load())
	enc, err := newH264Encoder(w, h, fps, bitrateFromQuality(int(s.quality.Load())))
	if err != nil {
		return wrapH264Err(err)
	}
	s.h264 = enc
	return nil
}

func (s *Session) sendHello(dc *webrtc.DataChannel) {
	displays := screenshot.Displays()
	if displays == nil {
		displays = []screenshot.DisplayInfo{}
	}
	d := int(s.display.Load())
	w, h := 0, 0
	if len(displays) > 0 {
		if d < 0 || d >= len(displays) {
			d = 0
		}
		w, h = displays[d].Width, displays[d].Height
	} else {
		w, h, _ = screenshot.DisplaySize()
	}
	s.width, s.height = w, h
	info, _ := json.Marshal(map[string]any{
		"type":               "hello",
		"width":              w,
		"height":             h,
		"fps":                s.fps.Load(),
		"codec":              s.codecName(),
		"audio":              s.audioOn.Load(),
		"reason":             s.fallbackReason(),
		"displays":           displays,
		"inputSupported":     inputSupported(),
		"clipboardSupported": clipSupported(),
		"clipboardWatch":     clipboardWatchMode(),
	})
	_ = dc.SendText(string(info))
}

func (s *Session) maybeCapture(dc *webrtc.DataChannel) {
	if s.codecName() == "h264" && s.videoTrack != nil {
		s.maybeCaptureH264(dc)
		return
	}
	buffered := dc.BufferedAmount()
	if buffered > highWater {
		return
	}
	quality := int(s.quality.Load())
	maxWidth := int(s.maxWidth.Load())
	if buffered > midWater {
		if quality > 30 {
			quality = 30
		}
		if maxWidth == 0 || maxWidth > 1280 {
			maxWidth = 1280
		}
	}
	jpeg, ww, hh, err := screenshot.CaptureDisplay(quality, int(s.display.Load()), maxWidth)
	if err != nil {
		s.captureFailed(dc, err)
		return
	}
	if len(jpeg) == 0 {
		s.captureFailed(dc, capture.ErrBlackFrame)
		return
	}
	s.width, s.height = ww, hh
	s.sendFrame(dc, jpeg)
}

func (s *Session) maybeCaptureH264(dc *webrtc.DataChannel) {
	s.encMu.Lock()
	if capEnc, ok := s.h264.(interface {
		CaptureEncode(display, maxWidth int) ([]byte, int, int, error)
	}); ok {
		nals, w, h, err := capEnc.CaptureEncode(int(s.display.Load()), h264CaptureMaxWidth(int(s.maxWidth.Load())))
		s.encMu.Unlock()
		if err != nil {
			s.fallbackToJPEG(dc, h264FallbackReason(err, nil))
			return
		}
		s.width, s.height = w, h
		s.writeH264Sample(nals)
		return
	}
	s.encMu.Unlock()
	img, err := screenshot.CaptureImage(int(s.display.Load()), h264CaptureMaxWidth(int(s.maxWidth.Load())))
	if err != nil || img == nil {
		s.captureFailed(dc, err)
		return
	}
	img = prepareH264Frame(img, int(s.maxWidth.Load()))
	b := img.Bounds()
	s.width, s.height = b.Dx(), b.Dy()
	s.encMu.Lock()
	if err := s.ensureH264EncoderLocked(img); err != nil {
		s.encMu.Unlock()
		s.fallbackToJPEG(dc, h264FallbackReason(err, nil))
		return
	}
	nals, err := s.h264.Encode(img)
	s.encMu.Unlock()
	if err != nil {
		s.fallbackToJPEG(dc, h264FallbackReason(err, nil))
		return
	}
	s.writeH264Sample(nals)
}

func (s *Session) writeH264Sample(nals []byte) {
	if len(nals) == 0 || s.videoTrack == nil {
		return
	}
	fps := s.fps.Load()
	if fps < 1 {
		fps = defaultFPS
	}
	if err := s.videoTrack.WriteSample(media.Sample{Data: nals, Duration: time.Second / time.Duration(fps)}); err != nil {
		return
	}
	s.bytesSent.Add(uint64(len(nals)))
	s.framesSent.Add(1)
	s.gotFrame.Store(true)
}

func (s *Session) fallbackToJPEG(dc *webrtc.DataChannel, reason string) {
	if s.codecName() == "jpeg" {
		if s.fallbackReason() == "" && reason != "" {
			s.fallback.Store(reason)
		}
		return
	}
	s.activeCodec.Store("jpeg")
	s.fallback.Store(reason)
	s.encMu.Lock()
	if s.h264 != nil {
		s.h264.Close()
		s.h264 = nil
	}
	s.encMu.Unlock()
	msg, _ := json.Marshal(map[string]any{"type": "codec", "codec": "jpeg", "reason": reason})
	if dc != nil && dc.ReadyState() == webrtc.DataChannelStateOpen {
		_ = dc.SendText(string(msg))
	}
}

func (s *Session) captureFailed(dc *webrtc.DataChannel, err error) {
	if err == nil || errors.Is(err, capture.ErrTimeout) {
		return
	}
	code := screenshot.ErrorCode(err)
	if s.log != nil {
		s.log.Notef("WARNING", "desktop capture: %v", err)
	}
	s.sendDeskJSON(map[string]any{"type": "error", "error": code})
	if screenshot.IsNoInteractiveSession(err) || !s.gotFrame.Load() {
		if s.hung.CompareAndSwap(false, true) {
			s.send(SignalPayload{Kind: "hangup", Error: code, Reason: code})
		}
	}
}

func (s *Session) clipWatch(dc *webrtc.DataChannel, stop <-chan struct{}) {
	s.pushClipHistory(dc)
	if snap, err := capture.SnapshotClip(); err == nil {
		s.pushClip(dc, snap)
	}
	ch := capture.WatchClip(stop)
	if ch == nil {
		go s.clipPoll(dc, stop)
		return
	}
	for {
		select {
		case <-stop:
			return
		case snap, ok := <-ch:
			if !ok {
				go s.clipPoll(dc, stop)
				return
			}
			s.pushClip(dc, snap)
		}
	}
}

func (s *Session) clipPoll(dc *webrtc.DataChannel, stop <-chan struct{}) {
	interval := 500 * time.Millisecond
	const maxInterval = 5 * time.Second
	var lastKey string
	for {
		select {
		case <-stop:
			return
		default:
		}
		snap, err := capture.SnapshotClip()
		if err == nil {
			item := clipFromCapture(snap)
			if clipKey(item) != lastKey {
				lastKey = clipKey(item)
				s.pushClip(dc, snap)
			}
			interval = 500 * time.Millisecond
		}
		select {
		case <-stop:
			return
		case <-time.After(interval):
		}
		if interval < maxInterval {
			interval = time.Duration(float64(interval) * 1.5)
			if interval > maxInterval {
				interval = maxInterval
			}
		}
	}
}

func (s *Session) pushClip(dc *webrtc.DataChannel, snap capture.Clip) {
	item := s.clipRing.PushClip(clipFromCapture(snap))
	if dc.ReadyState() != webrtc.DataChannelStateOpen {
		return
	}
	_ = dc.SendText(string(mustClipJSON(item)))
}

func (s *Session) pushClipHistory(dc *webrtc.DataChannel) {
	if dc == nil || dc.ReadyState() != webrtc.DataChannelStateOpen {
		return
	}
	for _, item := range s.clipRing.List() {
		_ = dc.SendText(string(mustClipJSON(item)))
	}
}

func (s *Session) sendStats(dc *webrtc.DataChannel, elapsed time.Duration) {
	frames := s.framesSent.Swap(0)
	bytes := s.bytesSent.Swap(0)
	sec := elapsed.Seconds()
	if sec <= 0 {
		sec = 1
	}
	msg, _ := json.Marshal(map[string]any{
		"type":  "stats",
		"fps":   float64(frames) / sec,
		"bytes": bytes,
		"rtt":   s.rttMs(),
	})
	_ = dc.SendText(string(msg))
}

func (s *Session) rttMs() float64 {
	s.mu.Lock()
	pc := s.pc
	s.mu.Unlock()
	if pc == nil {
		return 0
	}
	for _, st := range pc.GetStats() {
		pair, ok := st.(webrtc.ICECandidatePairStats)
		if !ok || !pair.Nominated {
			continue
		}
		if pair.CurrentRoundTripTime > 0 {
			return pair.CurrentRoundTripTime * 1000
		}
	}
	return 0
}

func (s *Session) sendFrame(dc *webrtc.DataChannel, jpeg []byte) {
	id := atomic.AddUint32(&s.frame, 1)
	count := (len(jpeg) + fragSize - 1) / fragSize
	if count < 1 {
		count = 1
	}
	for i := 0; i < count; i++ {
		if dc.BufferedAmount() > highWater {
			return
		}
		start := i * fragSize
		end := start + fragSize
		if end > len(jpeg) {
			end = len(jpeg)
		}
		chunk := jpeg[start:end]
		msg := make([]byte, 12+len(chunk))
		copy(msg[0:4], frameMagic)
		binary.BigEndian.PutUint32(msg[4:8], id)
		binary.BigEndian.PutUint16(msg[8:10], uint16(i))
		binary.BigEndian.PutUint16(msg[10:12], uint16(count))
		copy(msg[12:], chunk)
		if err := dc.Send(msg); err != nil {
			return
		}
		s.bytesSent.Add(uint64(len(msg)))
	}
	s.framesSent.Add(1)
	s.gotFrame.Store(true)
}

type inputEvent struct {
	T        string   `json:"t"`
	Type     string   `json:"type"`
	X        float64  `json:"x"`
	Y        float64  `json:"y"`
	B        int      `json:"b"`
	Dy       float64  `json:"dy"`
	Key      string   `json:"key"`
	Code     string   `json:"code"`
	Down     bool     `json:"down"`
	Text     string   `json:"text"`
	FPS      *float64 `json:"fps"`
	Quality  *int     `json:"quality"`
	Display  *int     `json:"display"`
	MaxWidth *int     `json:"maxWidth"`
}

func (s *Session) handleInput(raw []byte, reply func([]byte)) {
	var ev inputEvent
	if err := json.Unmarshal(raw, &ev); err != nil {
		return
	}
	if ev.T == "ctrl" || ev.Type == "control" {
		s.applyCapture(ev.FPS, ev.Quality, ev.Display, ev.MaxWidth)
		return
	}
	switch ev.T {
	case "clip", "clipget", "cliplist":
		if !clipSupported() {
			if reply != nil {
				msg, _ := json.Marshal(map[string]any{"type": "clip", "ok": false, "error": "clipboard_unavailable", "at": time.Now().UnixMilli()})
				reply(msg)
			}
			return
		}
		s.handleClipInput(ev.T, raw, ev, reply)
		return
	}
	if !s.allow.Load() {
		return
	}
	if !inputSupported() {
		if s.inputUnsup.CompareAndSwap(false, true) && reply != nil {
			msg, _ := json.Marshal(map[string]any{"type": "input_unsupported"})
			reply(msg)
		}
		return
	}
	inject(ev, int(s.display.Load()))
}

func (s *Session) sendClipList(dc *webrtc.DataChannel) {
	if dc == nil || dc.ReadyState() != webrtc.DataChannelStateOpen || !clipSupported() {
		return
	}
	items := s.clipRing.List()
	out := make([]json.RawMessage, 0, len(items))
	for _, item := range items {
		out = append(out, json.RawMessage(mustClipJSON(item)))
	}
	msg, _ := json.Marshal(map[string]any{"type": "cliplist", "ok": true, "items": out, "at": time.Now().UnixMilli()})
	_ = dc.SendText(string(msg))
}

func (s *Session) handleClipInput(kind string, raw []byte, ev inputEvent, reply func([]byte)) {
	switch kind {
	case "clip":
		item, ok := clipItemFromWire(raw)
		if !ok {
			if ev.Text == "" {
				return
			}
			item = clipItem{Kind: "text", Text: ev.Text}
		}
		if len(item.Text) > clipCap {
			item.Text = item.Text[:clipCap]
		}
		if len(item.HTML) > clipCap {
			item.HTML = item.HTML[:clipCap]
		}
		if item.At == 0 {
			item.At = time.Now().UnixMilli()
		}
		if err := capture.SetClip(item.toCapture()); err != nil {
			if reply != nil {
				msg, _ := json.Marshal(map[string]any{"type": "clip", "ok": false, "error": capture.ErrorCode(err), "at": time.Now().UnixMilli()})
				reply(msg)
			}
			return
		}
		s.clipRing.PushClip(item)
		if reply != nil {
			msg, _ := json.Marshal(map[string]any{"type": "clip", "ok": true, "at": item.At})
			reply(msg)
		}
	case "clipget":
		snap, err := capture.SnapshotClip()
		at := time.Now().UnixMilli()
		if err != nil {
			if reply != nil {
				msg, _ := json.Marshal(map[string]any{"type": "clip", "ok": false, "error": capture.ErrorCode(err), "at": at})
				reply(msg)
			}
			return
		}
		item := s.clipRing.PushClip(clipFromCapture(snap))
		if reply != nil {
			msg := mustClipJSON(item)
			var m map[string]any
			_ = json.Unmarshal(msg, &m)
			m["ok"] = true
			msg, _ = json.Marshal(m)
			reply(msg)
		}
	case "cliplist":
		if reply == nil {
			return
		}
		items := s.clipRing.List()
		out := make([]json.RawMessage, 0, len(items))
		for _, item := range items {
			out = append(out, json.RawMessage(mustClipJSON(item)))
		}
		msg, _ := json.Marshal(map[string]any{"type": "cliplist", "ok": true, "items": out, "at": time.Now().UnixMilli()})
		reply(msg)
	}
}

func (s *Session) applyCapture(fps *float64, quality, display, maxWidth *int) {
	if fps != nil {
		v := int(*fps + 0.5)
		s.fps.Store(int32(clampInt(v, 1, 15)))
	}
	if quality != nil {
		s.quality.Store(int32(clampInt(*quality, 10, 90)))
	}
	if display != nil {
		s.display.Store(int32(clampInt(*display, 0, 31)))
	}
	if maxWidth != nil {
		w := *maxWidth
		if w != 0 {
			w = clampInt(w, 320, 3840)
		}
		s.maxWidth.Store(int32(w))
	}
}

func (s *Session) storeICE(raw []IceServerJSON) {
	parsed := parseICEServers(raw)
	if len(parsed) == 0 {
		return
	}
	s.mu.Lock()
	s.ice = parsed
	s.mu.Unlock()
}

func (s *Session) iceServers() []webrtc.ICEServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.ice) > 0 {
		out := make([]webrtc.ICEServer, len(s.ice))
		copy(out, s.ice)
		return out
	}
	return []webrtc.ICEServer{{URLs: []string{s.stun}}}
}

func parseICEServers(raw []IceServerJSON) []webrtc.ICEServer {
	out := make([]webrtc.ICEServer, 0, len(raw))
	for _, item := range raw {
		urls := urlsOf(item.URLs)
		if len(urls) == 0 {
			continue
		}
		srv := webrtc.ICEServer{URLs: urls}
		if item.Username != "" {
			srv.Username = item.Username
		}
		if item.Credential != "" {
			srv.Credential = item.Credential
		}
		out = append(out, srv)
	}
	return out
}

func urlsOf(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var one string
	if json.Unmarshal(raw, &one) == nil && one != "" {
		return []string{one}
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		return many
	}
	return nil
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
