//go:build windows

package capture

import (
	"errors"
	"image"
	"runtime"
	"sync"
	"time"

	"github.com/pc-manager/agent/internal/winsession"
)

var (
	localMu      sync.Mutex
	localDup     *dxgiDup
	localDisplay = -1

	dxgiOnce sync.Once
	dxgiJobs chan dxgiJob
)

type dxgiJob struct {
	fn  func() (*Frame, error)
	ret chan dxgiResult
}

type dxgiResult struct {
	f   *Frame
	err error
}

func closeLocalDXGI() {
	_, _ = dxgiDo(func() (*Frame, error) {
		if localDup != nil {
			localDup.close()
			localDup = nil
			localDisplay = -1
		}
		return nil, nil
	})
}

func useHelper() bool {
	if helperMode {
		return false
	}
	return winsession.InSession0()
}

func SessionHelper() bool { return useHelper() }

func Displays() []DisplayInfo {
	if useHelper() {
		if list, err := helperDisplays(); err == nil && len(list) > 0 {
			return list
		}
		return []DisplayInfo{}
	}
	if list := dxgiDisplays(); len(list) > 0 {
		return list
	}
	return gdiDisplays()
}

func NumDisplays() int {
	return len(Displays())
}

func JPEG(quality, display, maxWidth int) ([]byte, int, int, error) {
	f, err := grab(display, maxWidth, quality, formatJPEG)
	if err != nil {
		return nil, 0, 0, err
	}
	if len(f.JPEG) > 0 {
		return f.JPEG, f.Width, f.Height, nil
	}
	img := f.Image()
	if img == nil {
		return nil, 0, 0, ErrNoInteractiveSession
	}
	jpeg, err := encodeJPEG(img, quality)
	if err != nil {
		return nil, 0, 0, err
	}
	return jpeg, f.Width, f.Height, nil
}

func Image(display, maxWidth int) (image.Image, error) {
	f, err := grab(display, maxWidth, 70, formatBGRA)
	if err != nil {
		return nil, err
	}
	if img := f.Image(); img != nil {
		return img, nil
	}
	if len(f.JPEG) > 0 {
		img, err := decodeJPEG(f.JPEG)
		if err != nil {
			return nil, err
		}
		return ensureRGBA(img), nil
	}
	return nil, ErrNoInteractiveSession
}

func grab(display, maxWidth, quality int, format string) (*Frame, error) {
	if useHelper() {
		f, err := helperGrab(display, maxWidth, quality, format)
		if err != nil {
			return nil, err
		}
		if format == formatJPEG && len(f.JPEG) == 0 && f.Image() != nil {
			jpeg, err := encodeJPEG(f.Image(), quality)
			if err != nil {
				return nil, err
			}
			f.JPEG = jpeg
		}
		return f, nil
	}
	return localGrab(display, maxWidth, quality, format)
}

func localGrab(display, maxWidth, quality int, format string) (*Frame, error) {
	f, err := localDXGI(display, maxWidth)
	if err == nil && f != nil {
		return finishFrame(f, quality, format)
	}
	f, err = gdiGrab(display, maxWidth, false)
	if err == nil && f != nil {
		return finishFrame(f, quality, format)
	}
	f, err = gdiGrab(display, maxWidth, true)
	if err == nil && f != nil {
		return finishFrame(f, quality, format)
	}
	if winsession.InSession0() || !winsession.HasConsoleUser() {
		return nil, ErrNoInteractiveSession
	}
	return nil, ErrNoInteractiveSession
}

func finishFrame(f *Frame, quality int, format string) (*Frame, error) {
	if f == nil {
		return nil, ErrNoInteractiveSession
	}
	if format == formatJPEG && len(f.JPEG) == 0 {
		img := f.Image()
		if img == nil {
			return nil, ErrNoInteractiveSession
		}
		jpeg, err := encodeJPEG(img, quality)
		if err != nil {
			return nil, err
		}
		f.JPEG = jpeg
	}
	return f, nil
}

func fitRawFrame(f *Frame, format string) (*Frame, error) {
	if f == nil {
		return nil, ErrNoInteractiveSession
	}
	if format == formatJPEG {
		return f, nil
	}
	if len(f.Pix) == 0 || f.Width < 1 || f.Height < 1 {
		if len(f.JPEG) > 0 {
			return f, nil
		}
		return nil, ErrBlackFrame
	}
	want := format
	if want != formatNV12 {
		want = formatBGRA
	}
	maxW := maxWidthFittingPipe(f.Width, f.Height, f.Width, want)
	if maxW < f.Width {
		scaled, err := stretchBGRA(f.Pix, f.Width, f.Height, f.Stride, maxW)
		if err != nil {
			return nil, err
		}
		f = scaled
	}
	if want == formatNV12 {
		nv := bgraToNV12(f.Pix, f.Stride, f.Width, f.Height)
		if len(nv) > maxBodyBytes {
			return nil, ErrFrameTooLarge
		}
		f.NV12 = nv
		f.Pix = nil
		f.Format = formatNV12
		f.Width, f.Height = evenDim(f.Width), evenDim(f.Height)
		return f, nil
	}
	if len(f.Pix) > maxBodyBytes {
		return fitRawFrame(f, formatNV12)
	}
	f.Format = formatBGRA
	return f, nil
}

func dxgiDo(fn func() (*Frame, error)) (*Frame, error) {
	dxgiOnce.Do(func() {
		dxgiJobs = make(chan dxgiJob, 4)
		go runDXGIThread()
	})
	ret := make(chan dxgiResult, 1)
	select {
	case dxgiJobs <- dxgiJob{fn: fn, ret: ret}:
	case <-time.After(8 * time.Second):
		return nil, ErrTimeout
	}
	select {
	case r := <-ret:
		return r.f, r.err
	case <-time.After(8 * time.Second):
		return nil, ErrTimeout
	}
}

func runDXGIThread() {
	runtime.LockOSThread()
	done, err := coInit()
	if err == nil {
		defer done()
	}
	for job := range dxgiJobs {
		f, err := job.fn()
		job.ret <- dxgiResult{f: f, err: err}
	}
}

func localDXGI(display, maxWidth int) (*Frame, error) {
	return dxgiDo(func() (*Frame, error) {
		localMu.Lock()
		defer localMu.Unlock()
		if localDup == nil || localDisplay != display {
			if localDup != nil {
				localDup.close()
				localDup = nil
			}
			d, err := openDXGI(display)
			if err != nil {
				return nil, err
			}
			localDup = d
			localDisplay = display
		}
		f, err := localDup.grab()
		if err != nil {
			if errors.Is(err, ErrTimeout) || errors.Is(err, ErrBlackFrame) {
				return nil, err
			}
			localDup.close()
			localDup = nil
			localDisplay = -1
			return nil, err
		}
		if maxWidth > 0 && f.Width > maxWidth {
			scaled, err := stretchBGRA(f.Pix, f.Width, f.Height, f.Stride, maxWidth)
			if err != nil {
				return nil, err
			}
			return scaled, nil
		}
		return f, nil
	})
}

func SnapshotClip() (Clip, error) {
	return snapshotClipWithFallback()
}

func SetClipText(text string) error {
	return SetClip(Clip{Kind: "text", Text: text})
}

func SetClip(c Clip) error {
	return setClipWithFallback(c)
}

func WatchClip(stop <-chan struct{}) <-chan Clip {
	if useHelper() {
		return helperClipWatch(stop)
	}
	ch := listenLocal(stop)
	if ch == nil {
		return pollWatchClip(stop)
	}
	return ch
}

func RunHelper(pipeName string) error {
	helperMode = true
	return runHelper(pipeName)
}
