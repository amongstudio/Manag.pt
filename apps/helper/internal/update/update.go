// Package update copies the agent's checksum-verify + binary replace path
// for a *local* update file. The helper does not download from the fleet API.
package update

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

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

func ReadExpectedSHA(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	text := strings.ReplaceAll(string(raw), "\ufeff", "")
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		return strings.ToLower(fields[0]), nil
	}
	return "", fmt.Errorf("no checksum in %s", path)
}

func VerifySHA256(path, expected string) error {
	expected = strings.ToLower(strings.TrimSpace(expected))
	if expected == "" {
		return fmt.Errorf("empty expected checksum")
	}
	got, err := SHA256File(path)
	if err != nil {
		return err
	}
	if !strings.EqualFold(got, expected) {
		return fmt.Errorf("checksum mismatch")
	}
	return nil
}

// VerifySignature checks HMAC-SHA256(secret, sha256hex) against sigHex.
func VerifySignature(shaHex, sigHex, secret string) error {
	if strings.TrimSpace(secret) == "" {
		return fmt.Errorf("update signing secret required")
	}
	if strings.TrimSpace(sigHex) == "" {
		return fmt.Errorf("update signature required")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(strings.ToLower(strings.TrimSpace(shaHex))))
	want := hex.EncodeToString(mac.Sum(nil))
	got, err := hex.DecodeString(strings.TrimSpace(sigHex))
	if err != nil {
		return fmt.Errorf("invalid signature encoding")
	}
	wantB, err := hex.DecodeString(want)
	if err != nil || len(got) != len(wantB) || !hmac.Equal(got, wantB) {
		return fmt.Errorf("signature mismatch")
	}
	return nil
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

func replaceFile(src, dest string) error {
	if err := os.Rename(src, dest); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
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

func restore(bak, target string) error {
	if _, err := os.Stat(bak); err != nil {
		return err
	}
	return replaceFile(bak, target)
}

// Apply verifies checksum, replaces target with newPath, and probes `version`.
func Apply(target, newPath, expectedSHA string) error {
	return apply(target, newPath, expectedSHA, true)
}

// Replace swaps target for newPath without a checksum (caller already verified).
func Replace(target, newPath string) error {
	return apply(target, newPath, "", true)
}

func apply(target, newPath, expectedSHA string, probe bool) error {
	if expectedSHA != "" {
		if err := VerifySHA256(newPath, expectedSHA); err != nil {
			return err
		}
	}
	bak := target + ".bak"
	if _, err := os.Stat(target); err == nil {
		_ = os.Remove(bak)
		if err := replaceFile(target, bak); err != nil {
			return err
		}
	}
	if err := replaceFile(newPath, target); err != nil {
		if rerr := restore(bak, target); rerr != nil {
			return fmt.Errorf("replace failed: %w (restore failed: %v)", err, rerr)
		}
		return err
	}
	_ = os.Chmod(target, 0o755)
	if probe {
		if err := ProbeVersion(target); err != nil {
			if qerr := replaceFile(target, target+".failed"); qerr != nil {
				if rerr := restore(bak, target); rerr != nil {
					return fmt.Errorf("version probe: %w (quarantine failed: %v; rollback failed: %v)", err, qerr, rerr)
				}
				return fmt.Errorf("version probe: %w (quarantine failed: %v; rolled back)", err, qerr)
			}
			if rerr := restore(bak, target); rerr != nil {
				return fmt.Errorf("version probe: %w (rollback failed: %v)", err, rerr)
			}
			return fmt.Errorf("version probe: %w; rolled back", err)
		}
	}
	return nil
}
