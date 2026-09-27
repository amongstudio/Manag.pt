package mesh

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pc-manager/agent/internal/peerfile"
	"github.com/pc-manager/agent/internal/wsprotocol"
	"github.com/pion/webrtc/v4"
)

const (
	wanChannel    = "pm-mesh"
	wanICETimeout = 20 * time.Second
	relayTimeout  = 45 * time.Second
)

type wanSession struct {
	id      string
	peer    string
	pc      *webrtc.PeerConnection
	ready   chan net.Conn
	errc    chan error
	offerer bool
}

type relayReply struct {
	status string
	result any
}

func meshAPI() *webrtc.API {
	var se webrtc.SettingEngine
	se.DetachDataChannels()
	return webrtc.NewAPI(webrtc.WithSettingEngine(se))
}

func (m *Manager) pionICE() []webrtc.ICEServer {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]webrtc.ICEServer, 0, len(m.ice))
	for _, item := range m.ice {
		urls := item.urlList()
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

func (m *Manager) emitSignal(to, sessionID, kind, sdp, sdpType string, candidate any) error {
	m.mu.Lock()
	sig := m.signal
	m.mu.Unlock()
	if sig == nil {
		return ErrUnreachable
	}
	return sig(map[string]any{
		"type": wsprotocol.TypeMeshSignal,
		"payload": map[string]any{
			"sessionId": sessionID,
			"to":        to,
			"kind":      kind,
			"sdp":       sdp,
			"sdpType":   sdpType,
			"candidate": candidate,
		},
	})
}

func (m *Manager) offerWANFile(destID, srcPath string, hdr peerfile.FileHead, progress func(int)) (peerfile.Result, error) {
	conn, err := m.dialWAN(destID)
	if err != nil {
		return peerfile.Result{}, err
	}
	defer conn.Close()
	return peerfile.SendFile(conn, srcPath, hdr, progress)
}

func (m *Manager) offerWANCmd(destID, self, cmdType, resultID string, payload json.RawMessage) (cmdResult, error) {
	conn, err := m.dialWAN(destID)
	if err != nil {
		return cmdResult{}, err
	}
	defer conn.Close()
	return exchangeCmd(conn, self, destID, cmdType, resultID, payload)
}

func (m *Manager) dialWAN(destID string) (net.Conn, error) {
	m.mu.Lock()
	want := m.policy.Enabled && m.policy.WAN && hasTURN(m.ice) && m.signal != nil && m.ident != nil
	ident := m.ident
	revoked := cloneRevoked(m.revoked)
	m.mu.Unlock()
	if !want {
		return nil, ErrUnreachable
	}
	sessionID := uuid.NewString()
	pc, err := m.newPeerConn()
	if err != nil {
		return nil, err
	}
	sess := &wanSession{
		id:      sessionID,
		peer:    destID,
		pc:      pc,
		ready:   make(chan net.Conn, 1),
		errc:    make(chan error, 1),
		offerer: true,
	}
	m.wanMu.Lock()
	m.wanSess[sessionID] = sess
	m.wanMu.Unlock()

	fail := func(err error) (net.Conn, error) {
		m.dropWAN(sessionID)
		return nil, err
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		_ = m.emitSignal(destID, sessionID, "ice", "", "", c.ToJSON())
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			select {
			case sess.errc <- ErrUnreachable:
			default:
			}
		}
	})
	ordered := true
	dc, err := pc.CreateDataChannel(wanChannel, &webrtc.DataChannelInit{Ordered: &ordered})
	if err != nil {
		return fail(err)
	}
	dc.OnOpen(func() { m.finishWAN(sess, dc, ident, destID, revoked, false) })

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fail(err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		return fail(err)
	}
	local := pc.LocalDescription()
	if local == nil {
		return fail(ErrUnreachable)
	}
	if err := m.emitSignal(destID, sessionID, "offer", local.SDP, "offer", nil); err != nil {
		return fail(err)
	}
	t := time.NewTimer(wanICETimeout)
	defer t.Stop()
	select {
	case conn := <-sess.ready:
		return &sessConn{Conn: conn, drop: func() { m.dropWAN(sessionID) }}, nil
	case err := <-sess.errc:
		if err == nil {
			err = ErrUnreachable
		}
		return fail(err)
	case <-t.C:
		return fail(ErrUnreachable)
	}
}

func (m *Manager) HandleSignal(raw json.RawMessage) {
	var frame wsprotocol.MeshSignal
	if json.Unmarshal(raw, &frame) != nil {
		var wrap struct {
			Payload wsprotocol.MeshSignalPayload `json:"payload"`
		}
		if json.Unmarshal(raw, &wrap) != nil {
			return
		}
		frame.Payload = wrap.Payload
	}
	p := frame.Payload
	if p.SessionID == "" || p.Kind == "" {
		return
	}
	switch strings.ToLower(p.Kind) {
	case "offer":
		m.answerWAN(p)
	case "answer":
		m.applyWANAnswer(p)
	case "ice":
		m.applyWANICE(p)
	case "hangup":
		m.dropWAN(p.SessionID)
	}
}

func (m *Manager) answerWAN(p wsprotocol.MeshSignalPayload) {
	from := strings.TrimSpace(p.From)
	if from == "" || p.SDP == "" {
		return
	}
	m.mu.Lock()
	want := m.policy.Enabled && m.policy.WAN && hasTURN(m.ice) && m.ident != nil
	ident := m.ident
	revoked := cloneRevoked(m.revoked)
	m.mu.Unlock()
	if !want {
		_ = m.emitSignal(from, p.SessionID, "hangup", "", "", nil)
		return
	}
	pc, err := m.newPeerConn()
	if err != nil {
		return
	}
	sess := &wanSession{
		id:    p.SessionID,
		peer:  from,
		pc:    pc,
		ready: make(chan net.Conn, 1),
		errc:  make(chan error, 1),
	}
	m.wanMu.Lock()
	m.wanSess[p.SessionID] = sess
	m.wanMu.Unlock()

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		_ = m.emitSignal(from, p.SessionID, "ice", "", "", c.ToJSON())
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != wanChannel {
			return
		}
		dc.OnOpen(func() { m.finishWAN(sess, dc, ident, from, revoked, true) })
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: p.SDP}); err != nil {
		m.dropWAN(p.SessionID)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		m.dropWAN(p.SessionID)
		return
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		m.dropWAN(p.SessionID)
		return
	}
	local := pc.LocalDescription()
	if local == nil {
		m.dropWAN(p.SessionID)
		return
	}
	_ = m.emitSignal(from, p.SessionID, "answer", local.SDP, "answer", nil)
	go func() {
		t := time.NewTimer(wanICETimeout)
		defer t.Stop()
		select {
		case conn := <-sess.ready:
			m.handleConn(conn)
			m.dropWAN(p.SessionID)
		case <-sess.errc:
			m.dropWAN(p.SessionID)
		case <-t.C:
			m.dropWAN(p.SessionID)
		}
	}()
}

func (m *Manager) applyWANAnswer(p wsprotocol.MeshSignalPayload) {
	m.wanMu.Lock()
	sess := m.wanSess[p.SessionID]
	m.wanMu.Unlock()
	if sess == nil || sess.pc == nil || p.SDP == "" {
		return
	}
	_ = sess.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: p.SDP})
}

func (m *Manager) applyWANICE(p wsprotocol.MeshSignalPayload) {
	m.wanMu.Lock()
	sess := m.wanSess[p.SessionID]
	m.wanMu.Unlock()
	if sess == nil || sess.pc == nil {
		return
	}
	init, ok := parseMeshICE(p.Candidate)
	if !ok {
		return
	}
	_ = sess.pc.AddICECandidate(init)
}

func (m *Manager) finishWAN(sess *wanSession, dc *webrtc.DataChannel, ident *Identity, peerID string, revoked map[string]struct{}, server bool) {
	raw, err := dc.Detach()
	if err != nil {
		select {
		case sess.errc <- err:
		default:
		}
		return
	}
	base := &rwcConn{ReadWriteCloser: raw, remote: peerID}
	var conn net.Conn
	if server {
		tc := tls.Server(base, ident.TLSConfig(true, "", revoked))
		if err := tc.Handshake(); err != nil {
			_ = base.Close()
			select {
			case sess.errc <- err:
			default:
			}
			return
		}
		conn = tc
	} else {
		tc := tls.Client(base, ident.TLSConfig(false, peerID, revoked))
		if err := tc.Handshake(); err != nil {
			_ = base.Close()
			select {
			case sess.errc <- err:
			default:
			}
			return
		}
		conn = tc
	}
	select {
	case sess.ready <- conn:
	default:
		_ = conn.Close()
	}
}

func (m *Manager) newPeerConn() (*webrtc.PeerConnection, error) {
	return meshAPI().NewPeerConnection(webrtc.Configuration{ICEServers: m.pionICE()})
}

func (m *Manager) dropWAN(id string) {
	m.wanMu.Lock()
	sess := m.wanSess[id]
	delete(m.wanSess, id)
	m.wanMu.Unlock()
	if sess != nil && sess.pc != nil {
		_ = sess.pc.Close()
	}
}

func (m *Manager) relayCmd(destID, cmdType string, payload json.RawMessage, resultID string) (cmdResult, error) {
	m.mu.Lock()
	sig := m.signal
	m.mu.Unlock()
	if sig == nil {
		return cmdResult{}, ErrUnreachable
	}
	ch := make(chan relayReply, 1)
	m.wanMu.Lock()
	m.relayWait[resultID] = ch
	m.wanMu.Unlock()
	defer func() {
		m.wanMu.Lock()
		delete(m.relayWait, resultID)
		m.wanMu.Unlock()
	}()
	if err := sig(map[string]any{
		"type":     wsprotocol.TypeMeshRelay,
		"to":       destID,
		"cmdType":  cmdType,
		"payload":  json.RawMessage(payload),
		"resultId": resultID,
	}); err != nil {
		return cmdResult{}, err
	}
	t := time.NewTimer(relayTimeout)
	defer t.Stop()
	select {
	case r := <-ch:
		return cmdResult{Status: r.status, Result: r.result}, nil
	case <-t.C:
		return cmdResult{}, ErrUnreachable
	}
}

func (m *Manager) HandleRelay(raw json.RawMessage) {
	var frame wsprotocol.MeshRelay
	if json.Unmarshal(raw, &frame) != nil {
		return
	}
	from := strings.TrimSpace(frame.From)
	if from == "" || frame.CmdType == "" || frame.ResultID == "" {
		return
	}
	m.mu.Lock()
	policy := m.policy
	exec := m.exec
	sig := m.signal
	m.mu.Unlock()
	status := "failed"
	var result any
	var err error
	if !CommandAllowed(policy, frame.CmdType) {
		result = map[string]string{"error": "not_allowed"}
		err = fmt.Errorf("not_allowed")
	} else if exec == nil {
		result = map[string]string{"error": "peer_refused"}
		err = fmt.Errorf("peer_refused")
	} else {
		payload := frame.Payload
		if len(payload) == 0 {
			payload = json.RawMessage(`{}`)
		}
		result, err = exec(frame.CmdType, payload)
		if err == nil {
			status = "success"
		} else if result == nil {
			result = map[string]string{"error": err.Error()}
		}
	}
	m.audit.Append(AuditEntry{Op: "cmd", PeerID: from, CmdType: frame.CmdType, ResultID: frame.ResultID, OK: err == nil, Error: errString(err)})
	if sig != nil {
		_ = sig(wsprotocol.MeshRelayResult{
			Type:     wsprotocol.TypeMeshRelayResult,
			To:       from,
			ResultID: frame.ResultID,
			Status:   status,
			Result:   result,
		})
	}
}

func (m *Manager) HandleRelayResult(raw json.RawMessage) {
	var frame wsprotocol.MeshRelayResult
	if json.Unmarshal(raw, &frame) != nil {
		return
	}
	m.wanMu.Lock()
	ch := m.relayWait[frame.ResultID]
	m.wanMu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- relayReply{status: frame.Status, result: frame.Result}:
	default:
	}
}

func parseMeshICE(candidate any) (webrtc.ICECandidateInit, bool) {
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
	if json.Unmarshal(raw, &init) != nil || strings.TrimSpace(init.Candidate) == "" {
		return webrtc.ICECandidateInit{}, false
	}
	return init, true
}

type rwcAddr struct{ s string }

func (a rwcAddr) Network() string { return "webrtc" }
func (a rwcAddr) String() string  { return a.s }

type rwcConn struct {
	io.ReadWriteCloser
	remote string
}

func (c *rwcConn) LocalAddr() net.Addr              { return rwcAddr{"mesh"} }
func (c *rwcConn) RemoteAddr() net.Addr             { return rwcAddr{c.remote} }
func (c *rwcConn) SetDeadline(time.Time) error      { return nil }
func (c *rwcConn) SetReadDeadline(time.Time) error  { return nil }
func (c *rwcConn) SetWriteDeadline(time.Time) error { return nil }

type sessConn struct {
	net.Conn
	drop func()
}

func (c *sessConn) Close() error {
	err := c.Conn.Close()
	if c.drop != nil {
		c.drop()
	}
	return err
}
