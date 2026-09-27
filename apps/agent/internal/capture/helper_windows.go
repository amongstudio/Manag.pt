//go:build windows

package capture

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/pc-manager/agent/internal/winsession"
	"golang.org/x/sys/windows"
)

const pipePrefix = `\\.\pipe\pc-manager-cap-`

type helperClient struct {
	mu      sync.Mutex
	h       windows.Handle
	io      *pipeIO
	nextID  uint32
	pending map[uint32]chan reply
	clips   chan Clip
	proc    windows.Handle
	watch   bool
}

type reply struct {
	h    Header
	body []byte
	err  error
}

var (
	helperMu sync.Mutex
	helper   *helperClient
)

func randomPipeName() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return pipePrefix + fmt.Sprintf("%d-", os.Getpid()) + hex.EncodeToString(b[:])
}

func pipeSDDL(userSID string) string {
	sddl := "D:P(A;;GA;;;SY)(A;;GA;;;BA)"
	if userSID != "" {
		sddl += "(A;;GRGW;;;" + userSID + ")"
	}
	return sddl
}

func consoleUserSID() string {
	tok, err := winsession.ImpersonationToken()
	if err != nil {
		return ""
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return ""
	}
	return u.User.Sid.String()
}

func pipeSecurity() (*windows.SecurityAttributes, error) {
	sd, err := windows.SecurityDescriptorFromString(pipeSDDL(consoleUserSID()))
	if err != nil {
		return nil, err
	}
	return &windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: sd,
	}, nil
}

func spawnCaptureHelper(pipeName string) (windows.Handle, error) {
	exe, err := os.Executable()
	if err != nil {
		return 0, err
	}
	cmdline := `"` + exe + `" capture-helper --pipe ` + pipeName
	pi, err := winsession.LaunchInSession(exe, cmdline, nil, false, windows.CREATE_NO_WINDOW)
	if err != nil {
		return 0, err
	}
	windows.CloseHandle(pi.Thread)
	return pi.Process, nil
}

func connectHelper() (*helperClient, error) {
	if !winsession.HasConsoleUser() {
		return nil, ErrNoInteractiveSession
	}
	sa, err := pipeSecurity()
	if err != nil {
		return nil, err
	}
	name := randomPipeName()
	name16, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateNamedPipe(
		name16,
		windows.PIPE_ACCESS_DUPLEX,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT,
		1,
		1<<20,
		1<<20,
		0,
		sa,
	)
	if err != nil {
		return nil, err
	}
	proc, err := spawnCaptureHelper(name)
	if err != nil {
		windows.CloseHandle(h)
		return nil, WrapNoSession(err)
	}
	done := make(chan error, 1)
	go func() {
		done <- windows.ConnectNamedPipe(h, nil)
	}()
	select {
	case err := <-done:
		if err != nil && err != windows.ERROR_PIPE_CONNECTED {
			windows.CloseHandle(h)
			windows.TerminateProcess(proc, 1)
			windows.CloseHandle(proc)
			return nil, WrapNoSession(err)
		}
	case <-time.After(8 * time.Second):
		windows.CloseHandle(h)
		windows.TerminateProcess(proc, 1)
		windows.CloseHandle(proc)
		return nil, WrapNoSession(fmt.Errorf("capture-helper connect timeout"))
	}
	c := &helperClient{
		h:       h,
		io:      &pipeIO{h: h},
		pending: make(map[uint32]chan reply),
		clips:   make(chan Clip, 8),
		proc:    proc,
	}
	go c.readLoop()
	return c, nil
}

func ensureHelper() (*helperClient, error) {
	helperMu.Lock()
	defer helperMu.Unlock()
	if helper != nil {
		return helper, nil
	}
	c, err := connectHelper()
	if err != nil {
		return nil, err
	}
	helper = c
	return c, nil
}

func dropHelper(c *helperClient) {
	helperMu.Lock()
	if helper == c {
		helper = nil
	}
	helperMu.Unlock()
	c.close()
}

func (c *helperClient) close() {
	c.mu.Lock()
	h := c.h
	p := c.proc
	c.h = 0
	c.mu.Unlock()
	if h != 0 {
		_ = writeMsg(c.io, Header{Op: opQuit}, nil)
		windows.CloseHandle(h)
	}
	if p != 0 {
		_ = windows.TerminateProcess(p, 0)
		windows.CloseHandle(p)
	}
}

func (c *helperClient) readLoop() {
	for {
		h, body, err := readMsg(c.io)
		if err != nil {
			c.failAll(err)
			dropHelper(c)
			return
		}
		if h.Op == opClip && h.ID == 0 {
			select {
			case c.clips <- headerToClip(h, body):
			default:
			}
			continue
		}
		c.mu.Lock()
		ch := c.pending[h.ID]
		delete(c.pending, h.ID)
		c.mu.Unlock()
		if ch != nil {
			ch <- reply{h: h, body: body}
		}
	}
}

func (c *helperClient) failAll(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, ch := range c.pending {
		ch <- reply{err: err}
		delete(c.pending, id)
	}
}

func (c *helperClient) call(req Header, body []byte, timeout time.Duration) (Header, []byte, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	req.ID = id
	ch := make(chan reply, 1)
	c.pending[id] = ch
	err := writeMsg(c.io, req, body)
	c.mu.Unlock()
	if err != nil {
		return Header{}, nil, err
	}
	select {
	case r := <-ch:
		if r.err != nil {
			return Header{}, nil, r.err
		}
		if !r.h.OK && r.h.Error != "" {
			if r.h.Error == CodeNoInteractiveSession {
				return r.h, r.body, ErrNoInteractiveSession
			}
			if r.h.Error == CodeTimeout || r.h.Error == ErrTimeout.Error() {
				return r.h, r.body, ErrTimeout
			}
			if r.h.Error == ErrBlackFrame.Error() {
				return r.h, r.body, ErrBlackFrame
			}
			if r.h.Error == CodeFrameTooLarge {
				return r.h, r.body, ErrFrameTooLarge
			}
			return r.h, r.body, fmt.Errorf("%s", r.h.Error)
		}
		return r.h, r.body, nil
	case <-time.After(timeout):
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return Header{}, nil, ErrHelperTimeout
	}
}

func helperGrab(display, maxWidth, quality int, format string) (*Frame, error) {
	c, err := ensureHelper()
	if err != nil {
		return nil, err
	}
	if quality <= 0 {
		quality = 70
	}
	wire := pipeCaptureFormat(format)
	h, body, err := c.call(Header{Op: opCapture, Display: display, MaxWidth: maxWidth, Quality: quality, Format: wire}, nil, 8*time.Second)
	if err != nil {
		if isPipeGone(err) {
			dropHelper(c)
		}
		return nil, err
	}
	f := &Frame{Width: h.Width, Height: h.Height, Stride: h.Width * 4}
	respFormat := h.Format
	if respFormat == "" {
		respFormat = wire
	}
	if respFormat == formatJPEG {
		f.JPEG = body
		f.Format = formatJPEG
		if format == formatBGRA && len(body) > 0 {
			img, err := decodeJPEG(body)
			if err != nil {
				return nil, err
			}
			rgba := ensureRGBA(img)
			if rgba != nil {
				f.img = rgba
				f.Width, f.Height = rgba.Bounds().Dx(), rgba.Bounds().Dy()
			}
		}
		return f, nil
	}
	if len(body) > maxBodyBytes {
		return nil, ErrFrameTooLarge
	}
	if respFormat == formatNV12 {
		f.NV12 = body
		f.Format = formatNV12
		f.Width, f.Height = evenDim(h.Width), evenDim(h.Height)
		return f, nil
	}
	f.Pix = body
	f.Format = formatBGRA
	return f, nil
}

func H264Frame(display, maxWidth, fps, bitrate int) ([]byte, int, int, error) {
	c, err := ensureHelper()
	if err != nil {
		return nil, 0, 0, err
	}
	h, body, err := c.call(Header{Op: opH264, Display: display, MaxWidth: maxWidth, FPS: fps, Bitrate: bitrate}, nil, 8*time.Second)
	if err != nil {
		if isPipeGone(err) {
			dropHelper(c)
		}
		return nil, 0, 0, err
	}
	return body, h.Width, h.Height, nil
}

func helperDisplays() ([]DisplayInfo, error) {
	c, err := ensureHelper()
	if err != nil {
		return nil, err
	}
	h, _, err := c.call(Header{Op: opDisplays}, nil, 5*time.Second)
	if err != nil {
		return nil, err
	}
	return h.Displays, nil
}

func helperClipGet() (Clip, error) {
	c, err := ensureHelper()
	if err != nil {
		return Clip{}, err
	}
	h, body, err := c.call(Header{Op: opClipGet}, nil, 3*time.Second)
	if err != nil {
		return Clip{}, err
	}
	return headerToClip(h, body), nil
}

func helperClipSet(clip Clip) error {
	c, err := ensureHelper()
	if err != nil {
		return err
	}
	h := clipToHeader(clip)
	h.Op = opClipSet
	_, _, err = c.call(h, clip.Image, 3*time.Second)
	return err
}

func helperClipWatch(stop <-chan struct{}) <-chan Clip {
	out := make(chan Clip, 8)
	go func() {
		defer close(out)
		c, err := ensureHelper()
		if err != nil {
			relayClipPoll(out, stop)
			return
		}
		_, _, _ = c.call(Header{Op: opClipWatch, Watch: true}, nil, 3*time.Second)
		for {
			select {
			case <-stop:
				_, _, _ = c.call(Header{Op: opClipWatch, Watch: false}, nil, 2*time.Second)
				return
			case clip, ok := <-c.clips:
				if !ok {
					relayClipPoll(out, stop)
					return
				}
				select {
				case out <- clip:
				case <-stop:
					_, _, _ = c.call(Header{Op: opClipWatch, Watch: false}, nil, 2*time.Second)
					return
				}
			}
		}
	}()
	return out
}

func relayClipPoll(out chan<- Clip, stop <-chan struct{}) {
	poll := pollWatchClip(stop)
	for {
		select {
		case <-stop:
			return
		case snap, ok := <-poll:
			if !ok {
				return
			}
			select {
			case out <- snap:
			case <-stop:
				return
			}
		}
	}
}

func isPipeGone(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch errno {
		case windows.ERROR_BROKEN_PIPE, windows.ERROR_PIPE_NOT_CONNECTED, windows.ERROR_NO_DATA:
			return true
		}
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "broken pipe")
}

func Shutdown() {
	helperMu.Lock()
	c := helper
	helper = nil
	helperMu.Unlock()
	if c != nil {
		c.close()
	}
	closeLocalDXGI()
}
