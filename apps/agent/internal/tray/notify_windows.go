//go:build windows

package tray

import (
	"io"
	"syscall"

	"github.com/lxn/win"
	"github.com/pc-manager/agent/internal/notify"
	"golang.org/x/sys/windows"
)

const wmNotifyBalloon = win.WM_USER + 33

type pipeReader struct {
	h windows.Handle
}

func (p *pipeReader) Read(b []byte) (int, error) {
	if p == nil || p.h == 0 {
		return 0, io.EOF
	}
	var n uint32
	err := windows.ReadFile(p.h, b, &n, nil)
	if n > 0 {
		return int(n), nil
	}
	if err != nil {
		return 0, err
	}
	return 0, io.EOF
}

func (h *host) serveNotify() {
	sa, err := notify.PipeSecurity()
	if err != nil {
		return
	}
	name16, err := windows.UTF16PtrFromString(notify.PipeName)
	if err != nil {
		return
	}
	pipe, err := windows.CreateNamedPipe(
		name16,
		windows.PIPE_ACCESS_INBOUND|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS,
		1,
		8192,
		8192,
		0,
		sa,
	)
	if err != nil {
		return
	}
	defer windows.CloseHandle(pipe)
	for {
		err := windows.ConnectNamedPipe(pipe, nil)
		if err != nil && err != windows.ERROR_PIPE_CONNECTED {
			return
		}
		msg, err := notify.ReadMessage(&pipeReader{h: pipe})
		_ = windows.DisconnectNamedPipe(pipe)
		if err != nil {
			continue
		}
		h.enqueue(msg)
	}
}

func (h *host) enqueue(msg notify.Message) {
	h.pendMu.Lock()
	h.pending = append(h.pending, msg)
	hwnd := h.hwnd
	h.pendMu.Unlock()
	if hwnd != 0 {
		win.PostMessage(hwnd, wmNotifyBalloon, 0, 0)
	}
}

func (h *host) drainBalloons() {
	h.pendMu.Lock()
	msgs := h.pending
	h.pending = nil
	h.pendMu.Unlock()
	for _, m := range msgs {
		h.showBalloon(m)
	}
}

func balloonFlags(kind string) uint32 {
	switch kind {
	case notify.KindWSDown, notify.KindAgentRecovering:
		return win.NIIF_WARNING
	default:
		return win.NIIF_INFO
	}
}

func copyUTF16(dst []uint16, s string) {
	u, err := syscall.UTF16FromString(s)
	if err != nil {
		return
	}
	n := len(u)
	if n > len(dst) {
		n = len(dst)
		u = u[:n]
		u[n-1] = 0
	}
	copy(dst, u)
}

func (h *host) showBalloon(msg notify.Message) {
	msg = msg.Normalized()
	copyUTF16(h.nid.SzInfoTitle[:], msg.Title)
	copyUTF16(h.nid.SzInfo[:], msg.Body)
	h.nid.DwInfoFlags = balloonFlags(msg.Kind)
	flags := h.nid.UFlags
	h.nid.UFlags = flags | win.NIF_INFO
	win.Shell_NotifyIcon(win.NIM_MODIFY, &h.nid)
	h.nid.UFlags = flags
}
