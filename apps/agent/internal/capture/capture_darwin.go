//go:build darwin

package capture

import (
	"fmt"
	"image"
)

func Shutdown() {}

func RunHelper(string) error { return ErrUnsupported }

func SessionHelper() bool { return false }

func Displays() []DisplayInfo { return []DisplayInfo{} }

func NumDisplays() int { return 0 }

func JPEG(int, int, int) ([]byte, int, int, error) {
	return nil, 0, 0, fmt.Errorf("screenshots are not supported on this darwin build")
}

func Image(int, int) (image.Image, error) {
	return nil, fmt.Errorf("screenshots are not supported on this darwin build")
}

func SnapshotClip() (Clip, error) { return Clip{}, ErrUnsupported }

func SetClipText(string) error { return ErrUnsupported }

func SetClip(Clip) error { return ErrUnsupported }

func WatchClip(<-chan struct{}) <-chan Clip { return nil }
