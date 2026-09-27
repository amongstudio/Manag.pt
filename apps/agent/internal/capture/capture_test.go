package capture

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
)

func TestErrorCodeNoInteractiveSession(t *testing.T) {
	if ErrorCode(ErrNoInteractiveSession) != CodeNoInteractiveSession {
		t.Fatal(ErrorCode(ErrNoInteractiveSession))
	}
	if ErrorCode(WrapNoSession(errors.New("token"))) != CodeNoInteractiveSession {
		t.Fatal("wrap")
	}
	if ErrorCode(ErrTimeout) != CodeTimeout {
		t.Fatal(ErrorCode(ErrTimeout))
	}
	if ErrorCode(ErrFrameTooLarge) != CodeFrameTooLarge {
		t.Fatal(ErrorCode(ErrFrameTooLarge))
	}
	if ErrorCode(errors.New("boom")) != CodeCaptureFailed {
		t.Fatal(ErrorCode(errors.New("boom")))
	}
}

func TestPipeRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	h := Header{ID: 7, Op: opCapture, Display: 1, MaxWidth: 1280, Quality: 70, Format: formatJPEG}
	body := []byte{1, 2, 3, 4}
	if err := writeMsg(&buf, h, body); err != nil {
		t.Fatal(err)
	}
	got, gotBody, err := readMsg(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != 7 || got.Op != opCapture || got.Display != 1 || string(gotBody) != string(body) {
		t.Fatalf("got=%+v body=%v", got, gotBody)
	}
}

func TestPipeRejectsHugeBody(t *testing.T) {
	var buf bytes.Buffer
	if err := writeMsg(&buf, Header{Op: opCapture}, make([]byte, maxBodyBytes+1)); err == nil {
		t.Fatal("expected body too large")
	}
}

func TestPipeCaptureFormat(t *testing.T) {
	if pipeCaptureFormat("") != formatJPEG {
		t.Fatalf("default %q", pipeCaptureFormat(""))
	}
	if pipeCaptureFormat(formatJPEG) != formatJPEG {
		t.Fatal("jpeg")
	}
	if pipeCaptureFormat(formatBGRA) != formatBGRA {
		t.Fatalf("bgra: %q", pipeCaptureFormat(formatBGRA))
	}
	if pipeCaptureFormat(formatNV12) != formatNV12 {
		t.Fatalf("nv12: %q", pipeCaptureFormat(formatNV12))
	}
	if opH264 != "h264" {
		t.Fatalf("op %q", opH264)
	}
}

func TestMaxWidthFittingPipe(t *testing.T) {
	if got := maxWidthFittingPipe(1920, 1080, 1920, formatBGRA); got != 1920 {
		t.Fatalf("1080p bgra width %d", got)
	}
	if pipeBodyLen(formatBGRA, 3840, 2160) <= maxBodyBytes {
		t.Fatal("4K BGRA should exceed 16MB")
	}
	w := maxWidthFittingPipe(3840, 2160, 3840, formatBGRA)
	bw, bh := scaleWH(3840, 2160, w)
	if pipeBodyLen(formatBGRA, bw, bh) > maxBodyBytes {
		t.Fatalf("fitted BGRA %dx%d still too large", bw, bh)
	}
	nv := maxWidthFittingPipe(3840, 2160, 3840, formatNV12)
	nw, nh := scaleWH(3840, 2160, nv)
	if pipeBodyLen(formatNV12, nw, nh) > maxBodyBytes {
		t.Fatalf("fitted NV12 %dx%d still too large", nw, nh)
	}
	if nv < 1920 {
		t.Fatalf("NV12 4K should still fit around 1080p+, got maxWidth %d", nv)
	}
}

func TestBgraNV12RoundTripSize(t *testing.T) {
	const w, h = 32, 16
	pix := make([]byte, w*h*4)
	for i := 0; i < len(pix); i += 4 {
		pix[i], pix[i+1], pix[i+2], pix[i+3] = 10, 20, 200, 255
	}
	nv := bgraToNV12(pix, w*4, w, h)
	if len(nv) != w*h+w*h/2 {
		t.Fatalf("nv12 len %d", len(nv))
	}
	img := nv12ToRGBA(nv, w, h)
	if img == nil || img.Bounds().Dx() != w || img.Bounds().Dy() != h {
		t.Fatal("nv12ToRGBA")
	}
}

func TestEncodeJPEGBGRA(t *testing.T) {
	const w, h = 32, 24
	pix := make([]byte, w*h*4)
	for i := 0; i < len(pix); i += 4 {
		pix[i], pix[i+1], pix[i+2], pix[i+3] = 10, 20, 200, 255
	}
	img := &bgraImage{pix: pix, stride: w * 4, w: w, h: h}
	out, err := encodeJPEG(img, 70)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) < 32 {
		t.Fatalf("jpeg too small: %d", len(out))
	}
	decoded, err := decodeJPEG(out)
	if err != nil {
		t.Fatal(err)
	}
	b := decoded.Bounds()
	if b.Dx() != w || b.Dy() != h {
		t.Fatalf("size %dx%d", b.Dx(), b.Dy())
	}
}

func TestParsePipeArg(t *testing.T) {
	if ParsePipeArg([]string{"--pipe", `\\.\pipe\foo`}) != `\\.\pipe\foo` {
		t.Fatal("flag")
	}
	if ParsePipeArg([]string{`--pipe=\\.\pipe\bar`}) != `\\.\pipe\bar` {
		t.Fatal("equals")
	}
	if ParsePipeArg([]string{`\\.\pipe\baz`}) != `\\.\pipe\baz` {
		t.Fatal("positional")
	}
}

func TestPresenceHeartbeatJSON(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{"type": "heartbeat"})
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if _, ok := m["cpu"]; ok {
		t.Fatalf("unexpected cpu: %s", raw)
	}
}

func TestMostlyBlack(t *testing.T) {
	pix := make([]byte, 64*64*4)
	if !isMostlyBlack(pix, 64*4, 64, 64) {
		t.Fatal("expected black")
	}
	pix[0], pix[1], pix[2] = 10, 20, 30
	if isMostlyBlack(pix, 64*4, 64, 64) {
		t.Fatal("sampled pixel should count as content")
	}
	for i := 0; i < len(pix); i += 4 {
		pix[i], pix[i+1], pix[i+2] = 40, 40, 40
	}
	if isMostlyBlack(pix, 64*4, 64, 64) {
		t.Fatal("expected content")
	}
}
