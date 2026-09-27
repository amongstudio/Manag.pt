//go:build windows

package shell

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"unsafe"

	"github.com/pc-manager/agent/internal/winsession"
	"golang.org/x/sys/windows"
)

type Session struct {
	mu      sync.Mutex
	hpc     windows.Handle
	proc    windows.Handle
	inW     windows.Handle
	outR    windows.Handle
	out     chan []byte
	err     error
	closed  bool
	attr    *windows.ProcThreadAttributeListContainer
}

func Supported() bool { return true }

func Open(kind string, cols, rows int) (*Session, error) {
	if cols < 1 {
		cols = 120
	}
	if rows < 1 {
		rows = 40
	}
	exe, args := shellCmd(kind)
	var sa windows.SecurityAttributes
	sa.Length = uint32(unsafe.Sizeof(sa))
	sa.InheritHandle = 1

	var inR, inW, outR, outW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, &sa, 0); err != nil {
		return nil, err
	}
	if err := windows.CreatePipe(&outR, &outW, &sa, 0); err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(inW)
		return nil, err
	}
	_ = windows.SetHandleInformation(inW, windows.HANDLE_FLAG_INHERIT, 0)
	_ = windows.SetHandleInformation(outR, windows.HANDLE_FLAG_INHERIT, 0)

	var hpc windows.Handle
	size := windows.Coord{X: int16(cols), Y: int16(rows)}
	if err := windows.CreatePseudoConsole(size, inR, outW, 0, &hpc); err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(inW)
		windows.CloseHandle(outR)
		windows.CloseHandle(outW)
		return nil, fmt.Errorf("CreatePseudoConsole: %w", err)
	}
	windows.CloseHandle(inR)
	windows.CloseHandle(outW)

	attr, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		windows.ClosePseudoConsole(hpc)
		windows.CloseHandle(inW)
		windows.CloseHandle(outR)
		return nil, err
	}
	hpcCopy := hpc
	if err := attr.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, unsafe.Pointer(&hpcCopy), unsafe.Sizeof(hpcCopy)); err != nil {
		attr.Delete()
		windows.ClosePseudoConsole(hpc)
		windows.CloseHandle(inW)
		windows.CloseHandle(outR)
		return nil, err
	}

	siEx := windows.StartupInfoEx{}
	siEx.Cb = uint32(unsafe.Sizeof(siEx))
	siEx.ProcThreadAttributeList = attr.List()
	desk, _ := windows.UTF16PtrFromString(winsession.DesktopName())
	siEx.Desktop = desk

	cmdline := `"` + exe + `"`
	if args != "" {
		cmdline += " " + args
	}

	var pi *windows.ProcessInformation
	if winsession.InSession0() {
		token, err := winsession.PrimaryUserToken()
		if err != nil {
			attr.Delete()
			windows.ClosePseudoConsole(hpc)
			windows.CloseHandle(inW)
			windows.CloseHandle(outR)
			return nil, err
		}
		defer token.Close()
		pi, err = winsession.StartUserProcess(
			token,
			exe,
			cmdline,
			&siEx.StartupInfo,
			true,
			windows.EXTENDED_STARTUPINFO_PRESENT|windows.CREATE_UNICODE_ENVIRONMENT,
		)
		if err != nil {
			attr.Delete()
			windows.ClosePseudoConsole(hpc)
			windows.CloseHandle(inW)
			windows.CloseHandle(outR)
			return nil, err
		}
	} else {
		app, err := windows.UTF16PtrFromString(exe)
		if err != nil {
			attr.Delete()
			windows.ClosePseudoConsole(hpc)
			windows.CloseHandle(inW)
			windows.CloseHandle(outR)
			return nil, err
		}
		cmd, err := windows.UTF16PtrFromString(cmdline)
		if err != nil {
			attr.Delete()
			windows.ClosePseudoConsole(hpc)
			windows.CloseHandle(inW)
			windows.CloseHandle(outR)
			return nil, err
		}
		var procInfo windows.ProcessInformation
		if err := windows.CreateProcess(app, cmd, nil, nil, true, windows.EXTENDED_STARTUPINFO_PRESENT, nil, nil, &siEx.StartupInfo, &procInfo); err != nil {
			attr.Delete()
			windows.ClosePseudoConsole(hpc)
			windows.CloseHandle(inW)
			windows.CloseHandle(outR)
			return nil, err
		}
		pi = &procInfo
	}
	windows.CloseHandle(pi.Thread)

	s := &Session{
		hpc:  hpc,
		proc: pi.Process,
		inW:  inW,
		outR: outR,
		out:  make(chan []byte, 16),
		attr: attr,
	}
	go s.readLoop()
	return s, nil
}

func shellCmd(kind string) (exe, args string) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	if kind == KindCmd {
		return filepath.Join(root, "System32", "cmd.exe"), ""
	}
	ps := filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	return ps, "-NoLogo"
}

func (s *Session) readLoop() {
	defer close(s.out)
	buf := make([]byte, 8192)
	for {
		var n uint32
		err := windows.ReadFile(s.outR, buf, &n, nil)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			s.out <- chunk
		}
		if err != nil {
			s.mu.Lock()
			if s.err == nil && !s.closed {
				s.err = err
			}
			s.mu.Unlock()
			return
		}
	}
}

func (s *Session) Write(p []byte) (int, error) {
	if s == nil || len(p) == 0 {
		return 0, nil
	}
	var n uint32
	err := windows.WriteFile(s.inW, p, &n, nil)
	return int(n), err
}

func (s *Session) Resize(cols, rows int) error {
	if s == nil || s.hpc == 0 {
		return errors.New("shell closed")
	}
	if cols < 1 || rows < 1 {
		return nil
	}
	return windows.ResizePseudoConsole(s.hpc, windows.Coord{X: int16(cols), Y: int16(rows)})
}

func (s *Session) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.mu.Unlock()
	if s.hpc != 0 {
		windows.ClosePseudoConsole(s.hpc)
		s.hpc = 0
	}
	if s.inW != 0 {
		windows.CloseHandle(s.inW)
		s.inW = 0
	}
	if s.outR != 0 {
		windows.CloseHandle(s.outR)
		s.outR = 0
	}
	if s.proc != 0 {
		_ = windows.TerminateProcess(s.proc, 0)
		windows.CloseHandle(s.proc)
		s.proc = 0
	}
	if s.attr != nil {
		s.attr.Delete()
		s.attr = nil
	}
}

func (s *Session) Output() <-chan []byte { return s.out }

func (s *Session) Done() <-chan struct{} { return nil }

func (s *Session) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

func IsUnsupported(error) bool { return false }

func IsNoSession(err error) bool {
	return errors.Is(err, winsession.ErrNoInteractiveSession)
}
