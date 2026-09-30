package moduletool

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pc-manager/agent/internal/client"
)

func testMeta(t *testing.T, kind string) *client.ModuleMeta {
	t.Helper()
	artifact := testPE(kind == "dll-plugin")
	sum := sha256.Sum256(artifact)
	meta := &client.ModuleMeta{
		ID:              "approved-tool",
		DisplayName:     "Approved tool",
		Version:         "1.0.0",
		Kind:            kind,
		Platform:        "windows",
		Arch:            "amd64",
		SHA256:          hex.EncodeToString(sum[:]),
		Size:            int64(len(artifact)),
		Entrypoint:      "approved-tool.exe",
		Action:          "inspect",
		ArgumentsSchema: []client.ModuleArgumentSpec{{Name: "count", Type: "integer", Required: true, MaxLength: 3}},
		TimeoutSec:      30,
		MaxOutputBytes:  4096,
		Enabled:         true,
	}
	if kind == "dll-plugin" {
		meta.Entrypoint = "approved-tool.dll"
	}
	seed := sha256.Sum256([]byte("moduletool-test-key"))
	privateKey := ed25519.NewKeyFromSeed(seed[:])
	publicKey := privateKey.Public().(ed25519.PublicKey)
	fingerprint := sha256.Sum256(publicKey)
	meta.PublicKey = base64.StdEncoding.EncodeToString(publicKey)
	meta.Signer = "ed25519:" + hex.EncodeToString(fingerprint[:])
	message, err := canonicalManifest(meta)
	if err != nil {
		t.Fatal(err)
	}
	meta.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, message))
	return meta
}

func testPE(dll bool) []byte {
	data := make([]byte, 512)
	data[0], data[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(data[0x3c:0x40], 0x80)
	copy(data[0x80:0x84], []byte("PE\x00\x00"))
	binary.LittleEndian.PutUint16(data[0x84:0x86], 0x8664)
	binary.LittleEndian.PutUint16(data[0x86:0x88], 1)
	binary.LittleEndian.PutUint16(data[0x94:0x96], 0xf0)
	binary.LittleEndian.PutUint16(data[0x96:0x98], 0x0002)
	binary.LittleEndian.PutUint16(data[0x98:0x9a], 0x20b)
	if dll {
		binary.LittleEndian.PutUint16(data[0x96:0x98], 0x2002)
	}
	return data
}

func TestManifestSignatureAndTamperFailure(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("test manifest targets windows/amd64")
	}
	meta := testMeta(t, "exe")
	if err := verifyManifest(meta, meta.Signature); err != nil {
		t.Fatalf("valid signature: %v", err)
	}
	meta.DisplayName = "Tampered"
	if err := verifyManifest(meta, meta.Signature); err == nil || !strings.Contains(err.Error(), "verification failed") {
		t.Fatalf("expected signature failure, got %v", err)
	}
}

func TestArgumentValidation(t *testing.T) {
	schema := []client.ModuleArgumentSpec{
		{Name: "count", Type: "integer", Required: true, MaxLength: 3},
		{Name: "mode", Type: "string", MaxLength: 8, Choices: []string{"safe", "audit"}},
		{Name: "verbose", Type: "boolean", MaxLength: 5},
	}
	if err := validateArgs(schema, []string{"12", "safe", "true"}); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{}, {"01"}, {"12", "other"}, {"12", "safe", "yes"}, {"12", "safe", "true", "extra"}} {
		if err := validateArgs(schema, args); err == nil {
			t.Fatalf("expected invalid args: %#v", args)
		}
	}
}

func TestPEKindAndHashValidation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tool.exe")
	data := testPE(false)
	if err := os.WriteFile(path, data, 0o700); err != nil {
		t.Fatal(err)
	}
	meta := testMeta(t, "exe")
	if err := verifyArtifact(path, meta); err != nil {
		t.Fatalf("valid artifact: %v", err)
	}
	data[300] = 1
	if err := os.WriteFile(path, data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := verifyArtifact(path, meta); err == nil || !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("expected hash mismatch, got %v", err)
	}

	dllPath := filepath.Join(dir, "plugin.dll")
	if err := os.WriteFile(dllPath, testPE(true), 0o600); err != nil {
		t.Fatal(err)
	}
	kind, arch, err := inspectPE(dllPath)
	if err != nil || kind != "dll-plugin" || arch != "amd64" {
		t.Fatalf("inspect DLL: %s %s %v", kind, arch, err)
	}
}

func TestOutputCapAndPendingCancellation(t *testing.T) {
	var output capBuffer
	output.limit = 4
	n, err := output.Write([]byte("123456"))
	if err != nil || n != 6 || output.String() != "1234" {
		t.Fatalf("bounded write: n=%d out=%q err=%v", n, output.String(), err)
	}
	Cancel("cmd-before-run")
	ctx, cancel, cancelled := commandContext("cmd-before-run")
	defer finishCommand("cmd-before-run", cancel)
	if !cancelled || ctx.Err() == nil {
		t.Fatal("pending cancellation was not consumed")
	}
}

func TestUnsupportedDLLAndExecutionTimeout(t *testing.T) {
	if err := executableKind("dll-plugin"); err == nil || !strings.Contains(err.Error(), "not implemented") {
		t.Fatalf("expected unsupported DLL host, got %v", err)
	}
	if runtime.GOOS != "windows" {
		t.Skip("exe timeout is Windows-only")
	}
	meta := testMeta(t, "exe")
	meta.TimeoutSec = 1
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	result, err := runExecutable(ctx, "cmd.exe", meta, []string{"/c", "ping -n 6 127.0.0.1 >nul"}, nil)
	if err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Fatalf("expected timeout, got result=%v err=%v", result, err)
	}
}
