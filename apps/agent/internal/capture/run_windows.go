//go:build windows

package capture

import (
	"fmt"
	"io"
	"sync"
	"time"

	"golang.org/x/sys/windows"
)

func runHelper(pipeName string) error {
	if pipeName == "" {
		return fmt.Errorf("capture-helper: missing --pipe")
	}
	done, err := coInit()
	if err != nil {
		return err
	}
	defer done()

	name16, err := windows.UTF16PtrFromString(pipeName)
	if err != nil {
		return err
	}
	var h windows.Handle
	deadline := time.Now().Add(8 * time.Second)
	for {
		h, err = windows.CreateFile(
			name16,
			windows.GENERIC_READ|windows.GENERIC_WRITE,
			0,
			nil,
			windows.OPEN_EXISTING,
			0,
			0,
		)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("capture-helper connect: %w", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	defer windows.CloseHandle(h)
	conn := &pipeIO{h: h}

	watchStop := make(chan struct{})
	watching := false
	defer func() {
		if watching {
			close(watchStop)
		}
	}()

	var writeMu sync.Mutex
	send := func(hdr Header, body []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = writeMsg(conn, hdr, body)
	}

	for {
		hdr, body, err := readMsg(conn)
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		switch hdr.Op {
		case opQuit, "":
			return nil
		case opPing:
			send(Header{ID: hdr.ID, Op: opPing, OK: true}, nil)
		case opDisplays:
			list := dxgiDisplays()
			if len(list) == 0 {
				list = gdiDisplays()
			}
			send(Header{ID: hdr.ID, Op: opDisplays, OK: true, Displays: list}, nil)
		case opCapture:
			format := pipeCaptureFormat(hdr.Format)
			quality := hdr.Quality
			if quality <= 0 {
				quality = 70
			}
			f, err := localGrab(hdr.Display, hdr.MaxWidth, quality, format)
			if err != nil {
				send(Header{ID: hdr.ID, Op: opCapture, Error: ErrorCode(err)}, nil)
				continue
			}
			f, err = fitRawFrame(f, format)
			if err != nil {
				send(Header{ID: hdr.ID, Op: opCapture, Error: ErrorCode(err)}, nil)
				continue
			}
			body := f.JPEG
			respFormat := format
			if f.Format != "" {
				respFormat = f.Format
			}
			switch respFormat {
			case formatNV12:
				body = f.NV12
			case formatBGRA:
				body = f.Pix
			}
			if len(body) > maxBodyBytes {
				send(Header{ID: hdr.ID, Op: opCapture, Error: CodeFrameTooLarge}, nil)
				continue
			}
			send(Header{
				ID:     hdr.ID,
				Op:     opCapture,
				OK:     true,
				Width:  f.Width,
				Height: f.Height,
				Format: respFormat,
			}, body)
		case opH264:
			if h264EncodeFn == nil {
				send(Header{ID: hdr.ID, Op: opH264, Error: "unsupported"}, nil)
				continue
			}
			fps := hdr.FPS
			if fps < 1 {
				fps = 5
			}
			bitrate := hdr.Bitrate
			if bitrate < 200_000 {
				bitrate = 200_000
			}
			nals, w, h, err := h264EncodeFn(hdr.Display, hdr.MaxWidth, fps, bitrate)
			if err != nil {
				msg := err.Error()
				if code := ErrorCode(err); code == CodeNoInteractiveSession || code == CodeFrameTooLarge || code == CodeTimeout {
					msg = code
				}
				send(Header{ID: hdr.ID, Op: opH264, Error: msg}, nil)
				continue
			}
			if len(nals) > maxBodyBytes {
				send(Header{ID: hdr.ID, Op: opH264, Error: CodeFrameTooLarge}, nil)
				continue
			}
			send(Header{ID: hdr.ID, Op: opH264, OK: true, Width: w, Height: h, Format: "h264"}, nals)
		case opClipGet:
			clip, err := snapshotLocal()
			if err != nil {
				send(Header{ID: hdr.ID, Op: opClipGet, Error: err.Error()}, nil)
				continue
			}
			h := clipToHeader(clip)
			h.ID = hdr.ID
			h.Op = opClipGet
			send(h, clip.Image)
		case opClipSet:
			if err := setLocalClip(headerToClip(hdr, body)); err != nil {
				send(Header{ID: hdr.ID, Op: opClipSet, Error: err.Error()}, nil)
				continue
			}
			send(Header{ID: hdr.ID, Op: opClipSet, OK: true}, nil)
		case opClipWatch:
			if hdr.Watch && !watching {
				watching = true
				watchStop = make(chan struct{})
				ch := listenLocal(watchStop)
				go func() {
					for clip := range ch {
						h := clipToHeader(clip)
						h.Op = opClip
						send(h, clip.Image)
					}
				}()
			}
			if !hdr.Watch && watching {
				close(watchStop)
				watching = false
			}
			send(Header{ID: hdr.ID, Op: opClipWatch, OK: true}, nil)
		default:
			send(Header{ID: hdr.ID, Op: hdr.Op, Error: "unknown op"}, nil)
		}
	}
}
