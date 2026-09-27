//go:build windows

package capture

import (
	"strings"
	"time"

	"github.com/pc-manager/agent/internal/winsession"
)

func clipDedupKey(c Clip) string {
	var b strings.Builder
	b.WriteString(c.Kind)
	b.WriteByte(0)
	b.WriteString(c.Text)
	b.WriteByte(0)
	b.WriteString(c.HTML)
	b.WriteByte(0)
	b.WriteString(c.Mime)
	if len(c.Image) > 0 {
		b.WriteString("img:")
		if len(c.Image) > 64 {
			b.Write(c.Image[:32])
			b.Write(c.Image[len(c.Image)-32:])
		} else {
			b.Write(c.Image)
		}
	}
	for _, p := range c.Files {
		b.WriteByte(0)
		b.WriteString(p)
	}
	return b.String()
}

func pollWatchClip(stop <-chan struct{}) <-chan Clip {
	out := make(chan Clip, 4)
	go func() {
		defer close(out)
		interval := 500 * time.Millisecond
		const maxInterval = 5 * time.Second
		var lastKey string
		for {
			select {
			case <-stop:
				return
			default:
			}
			snap, err := snapshotClipWithFallback()
			if err == nil {
				key := clipDedupKey(snap)
				if key != lastKey {
					lastKey = key
					select {
					case out <- snap:
						interval = 500 * time.Millisecond
					case <-stop:
						return
					}
				}
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
	}()
	return out
}

func snapshotClipWithFallback() (Clip, error) {
	if useHelper() {
		c, err := helperClipGet()
		if err == nil {
			return c, nil
		}
		return Clip{}, err
	}
	c, err := snapshotLocal()
	if err == nil {
		return c, nil
	}
	if hasHelperSession() {
		if c2, err2 := helperClipGet(); err2 == nil {
			return c2, nil
		}
	}
	return Clip{}, err
}

func setClipWithFallback(c Clip) error {
	if useHelper() {
		return helperClipSet(c)
	}
	err := setLocalClip(c)
	if err == nil {
		return nil
	}
	if hasHelperSession() {
		return helperClipSet(c)
	}
	return err
}

func hasHelperSession() bool {
	if helperMode {
		return false
	}
	return winsession.HasConsoleUser()
}
