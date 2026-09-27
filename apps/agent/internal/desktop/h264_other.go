//go:build !windows && !lite

package desktop

import (
	"errors"
)

var errH264Unavailable = errors.New("h264 is Windows-only")

func h264Available() bool { return false }

func initMediaRuntime() error { return nil }

func newH264Encoder(int, int, int, int) (h264Encoder, error) {
	return nil, errH264Unavailable
}
