//go:build windows

package updater

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"

	"github.com/pc-manager/agent/internal/winsvc"
	"golang.org/x/sys/windows"
)

func applyWindows(exe, newPath, bak string) error {
	pending := exe + ".new"
	if err := copyKeep(newPath, pending); err != nil {
		return err
	}
	if !sameFile(newPath, pending) {
		_ = os.Remove(newPath)
	}
	helper := winsvc.FindHelperBinary(exe)
	if helper == "" {
		if p := winsvc.InstalledHelperPath(); fileExists(p) {
			helper = p
		}
	}
	var cmd *exec.Cmd
	if helper != "" {
		cmd = exec.Command(helper, "apply-update")
	} else {
		self, err := os.Executable()
		if err != nil {
			return err
		}
		cmd = exec.Command(self, "finish-update", exe, pending, bak, strconv.Itoa(os.Getpid()))
	}
	cmd.SysProcAttr = &windows.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW | windows.DETACHED_PROCESS,
	}
	return cmd.Start()
}

func FinishUpdate(exe, pending, bak string) error {
	_ = winsvc.StopHelper()
	if err := winsvc.StopAgent(); err != nil {
		return err
	}
	if err := replaceAndProbe(exe, pending, bak); err != nil {
		_ = winsvc.CoordinatedStart()
		return err
	}
	return winsvc.CoordinatedStart()
}

func replaceAndProbe(exe, newPath, bak string) error {
	_ = os.Remove(bak)
	if _, err := os.Stat(exe); err == nil {
		if err := replaceFile(exe, bak); err != nil {
			return err
		}
	}
	if err := replaceFile(newPath, exe); err != nil {
		if rerr := replaceFile(bak, exe); rerr != nil {
			return fmt.Errorf("replace: %w (restore failed: %v)", err, rerr)
		}
		return err
	}
	_ = os.Chmod(exe, 0o755)
	if err := ProbeVersion(exe); err != nil {
		_ = os.Rename(exe, exe+".failed")
		if rerr := replaceFile(bak, exe); rerr != nil {
			return fmt.Errorf("version probe: %w (rollback failed: %v)", err, rerr)
		}
		return fmt.Errorf("version probe: %w; rolled back", err)
	}
	return nil
}

func copyKeep(src, dst string) error {
	if sameFile(src, dst) {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func sameFile(a, b string) bool {
	aa, err := filepath.Abs(a)
	if err != nil {
		aa = a
	}
	bb, err := filepath.Abs(b)
	if err != nil {
		bb = b
	}
	return filepath.Clean(aa) == filepath.Clean(bb)
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
