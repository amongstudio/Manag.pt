package screenshot

import (
	"errors"
	"image"

	"github.com/pc-manager/agent/internal/capture"
)

type DisplayInfo = capture.DisplayInfo

func NumDisplays() int { return capture.NumDisplays() }

func Displays() []DisplayInfo { return capture.Displays() }

func DisplaySize() (int, int, error) {
	return DisplaySizeN(0)
}

func DisplaySizeN(display int) (int, int, error) {
	list := Displays()
	if len(list) == 0 {
		return 0, 0, capture.ErrNoInteractiveSession
	}
	if display < 0 || display >= len(list) {
		display = 0
	}
	d := list[display]
	return d.Width, d.Height, nil
}

func Capture() ([]byte, error) {
	jpeg, _, _, err := capture.JPEG(70, 0, 0)
	return jpeg, err
}

func CaptureQuality(quality int) ([]byte, int, int, error) {
	return capture.JPEG(quality, 0, 0)
}

func CaptureDisplay(quality, display, maxWidth int) ([]byte, int, int, error) {
	return capture.JPEG(quality, display, maxWidth)
}

func CaptureImage(display, maxWidth int) (image.Image, error) {
	return capture.Image(display, maxWidth)
}

func ErrorCode(err error) string { return capture.ErrorCode(err) }

func IsNoInteractiveSession(err error) bool {
	return errors.Is(err, capture.ErrNoInteractiveSession)
}
