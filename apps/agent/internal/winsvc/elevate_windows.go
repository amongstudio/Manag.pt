//go:build windows

package winsvc

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"

	"github.com/pc-manager/agent/internal/config"
)

func IsElevated() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

func RelaunchElevated(arg string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	verb, err := syscall.UTF16PtrFromString("runas")
	if err != nil {
		return err
	}
	file, err := syscall.UTF16PtrFromString(exe)
	if err != nil {
		return err
	}
	params, err := syscall.UTF16PtrFromString(arg)
	if err != nil {
		return err
	}
	dir := filepath.Dir(exe)
	cwd, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	err = windows.ShellExecute(0, verb, file, params, cwd, windows.SW_SHOW)
	if err != nil {
		if errors.Is(err, windows.ERROR_CANCELLED) {
			return err
		}
		return err
	}
	return nil
}

func migrateUserConfigImpl() error {
	return config.MigrateUserToMachine()
}

func Confirm(title, body string) bool {
	text, err := syscall.UTF16PtrFromString(body)
	if err != nil {
		return false
	}
	caption, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return false
	}
	r, _ := windows.MessageBox(0, text, caption, windows.MB_YESNO|windows.MB_ICONWARNING|windows.MB_SETFOREGROUND)
	return r == 6 // IDYES
}

func Alert(title, body string) {
	text, _ := syscall.UTF16PtrFromString(body)
	caption, _ := syscall.UTF16PtrFromString(title)
	_, _ = windows.MessageBox(0, text, caption, windows.MB_OK|windows.MB_ICONERROR|windows.MB_SETFOREGROUND)
}
