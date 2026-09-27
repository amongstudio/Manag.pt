//go:build !windows && !darwin

package capture

import (
	"bytes"
	"image"
	"image/jpeg"

	"github.com/kbinani/screenshot"
)

func Shutdown() {}

func RunHelper(string) error { return ErrUnsupported }

func SessionHelper() bool { return false }

func Displays() []DisplayInfo {
	n := screenshot.NumActiveDisplays()
	if n < 0 {
		n = 0
	}
	out := make([]DisplayInfo, 0, n)
	for i := 0; i < n; i++ {
		b := screenshot.GetDisplayBounds(i)
		out = append(out, DisplayInfo{ID: i, X: b.Min.X, Y: b.Min.Y, Width: b.Dx(), Height: b.Dy()})
	}
	return out
}

func NumDisplays() int {
	n := screenshot.NumActiveDisplays()
	if n < 0 {
		return 0
	}
	return n
}

func JPEG(quality, display, maxWidth int) ([]byte, int, int, error) {
	n := NumDisplays()
	if n > 0 && (display < 0 || display >= n) {
		display = 0
	}
	bounds := screenshot.GetDisplayBounds(display)
	img, err := screenshot.CaptureRect(bounds)
	if err != nil {
		return nil, 0, 0, err
	}
	scaled := scaleMaxWidth(img, maxWidth)
	if quality <= 0 {
		quality = 70
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, scaled, &jpeg.Options{Quality: quality}); err != nil {
		return nil, 0, 0, err
	}
	if buf.Len() > maxJPEGBytes {
		buf.Reset()
		if err := jpeg.Encode(&buf, scaled, &jpeg.Options{Quality: 40}); err != nil {
			return nil, 0, 0, err
		}
	}
	b := scaled.Bounds()
	return buf.Bytes(), b.Dx(), b.Dy(), nil
}

func Image(display, maxWidth int) (image.Image, error) {
	n := NumDisplays()
	if n > 0 && (display < 0 || display >= n) {
		display = 0
	}
	bounds := screenshot.GetDisplayBounds(display)
	img, err := screenshot.CaptureRect(bounds)
	if err != nil {
		return nil, err
	}
	return scaleMaxWidth(img, maxWidth), nil
}

func scaleMaxWidth(src image.Image, maxWidth int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if maxWidth <= 0 || w <= maxWidth {
		return src
	}
	nw := maxWidth
	nh := h * nw / w
	if nh < 1 {
		nh = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	for y := 0; y < nh; y++ {
		sy := b.Min.Y + y*h/nh
		for x := 0; x < nw; x++ {
			sx := b.Min.X + x*w/nw
			dst.Set(x, y, src.At(sx, sy))
		}
	}
	return dst
}

func SnapshotClip() (Clip, error) { return Clip{}, ErrUnsupported }

func SetClipText(string) error { return ErrUnsupported }

func SetClip(Clip) error { return ErrUnsupported }

func WatchClip(<-chan struct{}) <-chan Clip { return nil }
