//go:build windows && !lite

package desktop

import (
	"fmt"
	"image"
	"sync"

	"github.com/pc-manager/agent/internal/capture"
	"github.com/pc-manager/agent/internal/screenshot"
)

var (
	helperEncMu sync.Mutex
	helperEnc   h264Encoder
	helperEW    int
	helperEH    int
)

func RegisterCaptureHelperH264() {
	capture.SetH264Encode(encodeHelperFrame)
}

func encodeHelperFrame(display, maxWidth, fps, bitrate int) ([]byte, int, int, error) {
	img, err := screenshot.CaptureImage(display, h264CaptureMaxWidth(maxWidth))
	if err != nil || img == nil {
		return nil, 0, 0, err
	}
	img = prepareH264Frame(img, maxWidth)
	b := img.Bounds()
	w, h := evenSize(b.Dx()), evenSize(b.Dy())
	helperEncMu.Lock()
	defer helperEncMu.Unlock()
	if helperEnc == nil || helperEW != w || helperEH != h {
		if helperEnc != nil {
			helperEnc.Close()
			helperEnc = nil
		}
		enc, err := newLocalH264Encoder(w, h, fps, bitrate)
		if err != nil {
			return nil, 0, 0, err
		}
		helperEnc = enc
		helperEW, helperEH = w, h
	}
	nals, err := helperEnc.Encode(img)
	return nals, w, h, err
}

type pipeH264 struct {
	w, h, fps, bitrate int
}

func newPipeH264Encoder(w, h, fps, bitrate int) (h264Encoder, error) {
	if !capture.SessionHelper() {
		return nil, fmt.Errorf("capture helper not active")
	}
	return &pipeH264{w: w, h: h, fps: fps, bitrate: bitrate}, nil
}

func (e *pipeH264) Size() (int, int) { return e.w, e.h }

func (e *pipeH264) Close() {}

func (e *pipeH264) Encode(img image.Image) ([]byte, error) {
	if img != nil {
		b := img.Bounds()
		e.w, e.h = evenSize(b.Dx()), evenSize(b.Dy())
	}
	nals, w, h, err := capture.H264Frame(0, e.w, e.fps, e.bitrate)
	if err != nil {
		return nil, err
	}
	if w > 0 {
		e.w = w
	}
	if h > 0 {
		e.h = h
	}
	return nals, nil
}

func (e *pipeH264) CaptureEncode(display, maxWidth int) ([]byte, int, int, error) {
	nals, w, h, err := capture.H264Frame(display, maxWidth, e.fps, e.bitrate)
	if err != nil {
		return nil, 0, 0, err
	}
	if w > 0 {
		e.w = w
	}
	if h > 0 {
		e.h = h
	}
	return nals, e.w, e.h, nil
}
