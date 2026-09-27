//go:build !windows && !lite

package desktop

import (
	"errors"

	"github.com/pion/webrtc/v4"
)

var errAudioUnavailable = errors.New("loopback audio is Windows-only")

func audioAvailable() bool { return false }

func startLoopbackAudio(*webrtc.TrackLocalStaticSample, <-chan struct{}, func(bool, string)) error {
	return errAudioUnavailable
}
