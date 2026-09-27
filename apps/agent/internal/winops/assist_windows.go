//go:build windows

package winops

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"github.com/pc-manager/agent/internal/notify"
	"github.com/pc-manager/agent/internal/winsession"
	"golang.org/x/sys/windows"
)

func StartQuickAssist(req AssistRequest) (*AssistResult, error) {
	if req.App == "" {
		req.App = "quickassist"
	}
	if req.App != "quickassist" && req.App != "msra" {
		return nil, ErrInvalidPayload
	}
	if !winsession.HasConsoleUser() {
		return nil, ErrNoSession
	}
	exe, cmdline, app, err := assistCommand(req.App)
	if err != nil {
		return nil, err
	}
	if err := startInConsoleSession(exe, cmdline); err != nil {
		if errorsIsNoSession(err) {
			return nil, ErrNoSession
		}
		return nil, err
	}
	notify.Post(notify.Message{
		Kind: notify.KindQuickAssist,
		Body: "Opened on the desktop.",
	})
	return &AssistResult{Started: true, App: app, Path: exe}, nil
}

func assistCommand(app string) (exe, cmdline, used string, err error) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	system32 := filepath.Join(root, "System32")
	quick := filepath.Join(system32, "quickassist.exe")
	msra := filepath.Join(system32, "msra.exe")
	explorer := filepath.Join(root, "explorer.exe")
	if app == "msra" {
		if !fileExists(msra) {
			return "", "", "", ErrAssistNotFound
		}
		return msra, quoted(msra), "msra", nil
	}
	if fileExists(quick) {
		return quick, quoted(quick), "quickassist", nil
	}
	if fileExists(explorer) {
		return explorer, quoted(explorer) + " ms-quick-assist:", "quickassist", nil
	}
	if fileExists(msra) {
		return msra, quoted(msra), "msra", nil
	}
	return "", "", "", ErrAssistNotFound
}

func quoted(path string) string {
	return `"` + path + `"`
}

func fileExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir() && allowedAssistPath(path)
}

func allowedAssistPath(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	if strings.HasSuffix(base, ".msc") {
		return false
	}
	switch base {
	case "quickassist.exe", "msra.exe", "explorer.exe":
		return true
	default:
		return false
	}
}

func startInConsoleSession(exe, cmdline string) error {
	if !allowedAssistPath(exe) {
		return ErrAssistRefused
	}
	var si windows.StartupInfo
	si.Cb = uint32(unsafe.Sizeof(si))
	si.Flags = windows.STARTF_USESHOWWINDOW
	si.ShowWindow = windows.SW_SHOWNORMAL
	desk, err := windows.UTF16PtrFromString(winsession.DesktopName())
	if err != nil {
		return err
	}
	si.Desktop = desk
	pi, err := winsession.LaunchInSession(exe, cmdline, &si, false, 0)
	if err != nil {
		return err
	}
	windows.CloseHandle(pi.Thread)
	windows.CloseHandle(pi.Process)
	return nil
}

func errorsIsNoSession(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, winsession.ErrNoInteractiveSession) ||
		strings.Contains(strings.ToLower(err.Error()), "no_interactive_session")
}
