package update

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSHA256AndSidecar(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "blob")
	if err := os.WriteFile(p, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	sum, err := SHA256File(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifySHA256(p, sum); err != nil {
		t.Fatal(err)
	}
	if err := VerifySHA256(p, "deadbeef"); err == nil {
		t.Fatal("expected mismatch")
	}
	side := p + ".sha256"
	if err := os.WriteFile(side, []byte(sum+"  blob\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := ReadExpectedSHA(side)
	if err != nil {
		t.Fatal(err)
	}
	if got != sum {
		t.Fatalf("sidecar %s != %s", got, sum)
	}
}

func TestApplyReplaceWithoutProbe(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "agent.bin")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	newPath := target + ".new"
	payload := []byte("new-binary")
	if err := os.WriteFile(newPath, payload, 0o644); err != nil {
		t.Fatal(err)
	}
	sum, err := SHA256File(newPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := apply(target, newPath, sum, false); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new-binary" {
		t.Fatalf("target contents: %q", got)
	}
	bak, err := os.ReadFile(target + ".bak")
	if err != nil {
		t.Fatal(err)
	}
	if string(bak) != "old" {
		t.Fatalf("bak contents: %q", bak)
	}
}

func TestApplyProbeRollback(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "agent.bin")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	newPath := target + ".new"
	if err := os.WriteFile(newPath, []byte("not-an-exe"), 0o644); err != nil {
		t.Fatal(err)
	}
	sum, err := SHA256File(newPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := apply(target, newPath, sum, true); err == nil {
		t.Fatal("expected probe rollback")
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "old" {
		t.Fatalf("target after rollback: %q", got)
	}
}

func TestVerifySignature(t *testing.T) {
	sum := "aabbcc"
	secret := "unit-test-secret"
	if err := VerifySignature(sum, "deadbeef", secret); err == nil {
		t.Fatal("expected mismatch")
	}
	mac := hmacSHA(secret, sum)
	if err := VerifySignature(sum, mac, secret); err != nil {
		t.Fatal(err)
	}
}

func TestReplaceWithoutChecksum(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "agent.bin")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	newPath := target + ".new"
	if err := os.WriteFile(newPath, []byte("staged"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := apply(target, newPath, "", false); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "staged" {
		t.Fatalf("got %q", got)
	}
}

func hmacSHA(secret, shaHex string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(strings.ToLower(strings.TrimSpace(shaHex))))
	return hex.EncodeToString(mac.Sum(nil))
}
