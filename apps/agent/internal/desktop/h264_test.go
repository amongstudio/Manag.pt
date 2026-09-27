//go:build !lite

package desktop

import (
	"errors"
	"fmt"
	"image"
	"image/color"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/pc-manager/agent/internal/capture"
)

func TestAvccToAnnexB(t *testing.T) {
	in := []byte{0, 0, 0, 3, 0x65, 0x88, 0x80, 0, 0, 0, 2, 0x09, 0x10}
	out := avccToAnnexB(in)
	want := []byte{0, 0, 0, 1, 0x65, 0x88, 0x80, 0, 0, 0, 1, 0x09, 0x10}
	if len(out) != len(want) {
		t.Fatalf("len %d want %d", len(out), len(want))
	}
	for i := range want {
		if out[i] != want[i] {
			t.Fatalf("byte %d: %02x != %02x", i, out[i], want[i])
		}
	}
}

func TestAvccToAnnexBPassthrough(t *testing.T) {
	in := []byte{0, 0, 0, 1, 0x67, 0x42}
	if got := avccToAnnexB(in); len(got) != len(in) || got[4] != 0x67 {
		t.Fatalf("passthrough failed")
	}
}

func TestBitrateFromQuality(t *testing.T) {
	if bitrateFromQuality(10) != 1_200_000 {
		t.Fatalf("q10=%d", bitrateFromQuality(10))
	}
	if bitrateFromQuality(90) != 7_600_000 {
		t.Fatalf("q90=%d", bitrateFromQuality(90))
	}
}

func TestImageToNV12Size(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 16, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 16; x++ {
			img.Set(x, y, color.RGBA{R: 32, G: 64, B: 128, A: 255})
		}
	}
	nv := imageToNV12(img, 16, 8)
	if len(nv) != 16*8+16*8/2 {
		t.Fatalf("nv12 len %d", len(nv))
	}
	i420 := imageToI420(img, 16, 8)
	if len(i420) != len(nv) {
		t.Fatalf("i420 len %d", len(i420))
	}
	at := imageToYUVAt(img, 16, 8, true)
	if len(at) != len(nv) {
		t.Fatalf("at len %d", len(at))
	}
	for i := range nv {
		if nv[i] != at[i] {
			t.Fatalf("fast path != At path at %d: %d %d", i, nv[i], at[i])
		}
	}
}

func TestH264FallbackUsesEncoderError(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 16, 16))
	encErr := fmt.Errorf("SetOutputType failed with HRESULT 0xc00d36b4")
	reason := h264FallbackReason(encErr, nil)
	if reason == "" || reason == "mf_init_failed" {
		t.Fatalf("encoder error swallowed: %q", reason)
	}
	if !strings.Contains(strings.ToLower(reason), "0xc00d36b4") {
		t.Fatalf("want HRESULT text, got %q", reason)
	}
	if h264FallbackReason(nil, nil) == "mf_init_failed" {
		t.Fatal("nil errors should not report mf_init_failed")
	}
	_ = img
}

func TestH264FallbackClassMissing(t *testing.T) {
	reason := h264FallbackReason(fmt.Errorf("CoCreateInstance failed with HRESULT 0x80040154"), nil)
	if reason != codeMFClassMissing {
		t.Fatalf("got %q", reason)
	}
	if wrapH264Err(fmt.Errorf("CoCreateInstance failed with HRESULT 0x80040154")).Error() != codeMFClassMissing {
		t.Fatal("wrap")
	}
	if h264FallbackReason(fmt.Errorf("QueryInterface failed with HRESULT 0x80004002"), nil) != codeMFTransformUnavailable {
		t.Fatal("E_NOINTERFACE should be transform-unavailable, not Media Feature Pack")
	}
	if wrapH264Err(fmt.Errorf("%s", codeMFTransformUnavailable)).Error() != codeMFTransformUnavailable {
		t.Fatal("wrap transform")
	}
}

func TestH264FallbackCaptureReasons(t *testing.T) {
	if got := h264FallbackReason(nil, capture.ErrNoInteractiveSession); got != codeNoSession {
		t.Fatalf("session: %q", got)
	}
	if got := h264FallbackReason(nil, capture.ErrFrameTooLarge); got != codeFrameTooLarge {
		t.Fatalf("size: %q", got)
	}
	if !errors.Is(capture.ErrNoInteractiveSession, capture.ErrNoInteractiveSession) {
		t.Fatal("sentinel")
	}
}

func TestH264CaptureMaxWidth(t *testing.T) {
	if h264CaptureMaxWidth(0) != maxH264Width {
		t.Fatalf("default %d", h264CaptureMaxWidth(0))
	}
	if h264CaptureMaxWidth(3840) != maxH264Width {
		t.Fatalf("4k cap %d", h264CaptureMaxWidth(3840))
	}
	if h264CaptureMaxWidth(1280) != 1280 {
		t.Fatalf("passthrough %d", h264CaptureMaxWidth(1280))
	}
	w, h := h264EncodeSize(3840, 2160, 0)
	if w != maxH264Width {
		t.Fatalf("encode width %d", w)
	}
	if h != evenSize(2160*maxH264Width/3840) {
		t.Fatalf("encode height %d", h)
	}
	img := image.NewRGBA(image.Rect(0, 0, 3840, 2160))
	got := prepareH264Frame(img, 0)
	b := got.Bounds()
	if b.Dx() > maxH264Width {
		t.Fatalf("prepared %dx%d", b.Dx(), b.Dy())
	}
}

func TestH264SDPFmtpLine(t *testing.T) {
	if !strings.Contains(h264SDPFmtpLine, "packetization-mode=1") {
		t.Fatalf("packetization: %s", h264SDPFmtpLine)
	}
	if !strings.Contains(h264SDPFmtpLine, "profile-level-id=42") {
		t.Fatalf("baseline: %s", h264SDPFmtpLine)
	}
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: h264SDPFmtpLine},
		"video", "desktop",
	)
	if err != nil {
		t.Fatal(err)
	}
	if track.Codec().SDPFmtpLine != h264SDPFmtpLine {
		t.Fatalf("track fmtp %q", track.Codec().SDPFmtpLine)
	}
}
