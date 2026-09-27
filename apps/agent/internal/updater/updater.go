package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/mod/semver"
)

func canonical(v string) string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	v = strings.TrimPrefix(v, "V")
	if v == "" {
		return ""
	}
	return "v" + v
}

// Compare reports whether remote is a newer semver than current.
func Compare(current, remote string) bool {
	c := canonical(current)
	r := canonical(remote)
	if r == "" {
		return false
	}
	if !semver.IsValid(r) {
		return false
	}
	if !semver.IsValid(c) {
		return true
	}
	return semver.Compare(r, c) > 0
}

func SHA256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func ProbeVersion(exe string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "version")
	out, err := cmd.Output()
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(out)) == "" {
		return fmt.Errorf("empty version output")
	}
	return nil
}

func Apply(newPath, expectedSHA string) error {
	got, err := SHA256File(newPath)
	if err != nil {
		return err
	}
	if !strings.EqualFold(got, expectedSHA) {
		_ = os.Remove(newPath)
		return fmt.Errorf("checksum mismatch")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	bak := exe + ".bak"
	_ = os.Remove(bak)
	if runtime.GOOS == "windows" {
		return applyWindows(exe, newPath, bak)
	}
	if err := replaceFile(exe, bak); err != nil {
		return err
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

func replaceFile(src, dest string) error {
	if err := os.Rename(src, dest); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Remove(src)
}

func SelfPath() string {
	exe, _ := os.Executable()
	return filepath.Clean(exe)
}
