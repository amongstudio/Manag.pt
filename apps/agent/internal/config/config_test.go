package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func isolateStore(t *testing.T) {
	t.Helper()
	t.Setenv("PC_MANAGER_CONFIG", "")
	t.Setenv("SERVER_URL", "")
	t.Setenv("ENROLLMENT_SECRET", "")
	t.Setenv("FALLBACK_URLS", "")
	t.Setenv("HEARTBEAT_INTERVAL_SEC", "")
	t.Setenv("ENABLE_GPU", "")
	t.Setenv("ENABLE_TEMPS", "")
	t.Setenv("ENABLE_WEBRTC", "")
	t.Setenv("LIGHTWEIGHT", "")
	isolateRegistry(t)
}

func TestDefaultUsesBakedServerURL(t *testing.T) {
	old := DefaultServerURL
	DefaultServerURL = "https://baked.example:8443"
	t.Cleanup(func() { DefaultServerURL = old })
	cfg := Default()
	if cfg.ServerURL != "https://baked.example:8443" {
		t.Fatalf("server url: %s", cfg.ServerURL)
	}
}

func TestLoadWithoutYAMLUsesDefaultServerURL(t *testing.T) {
	isolateStore(t)
	old := DefaultServerURL
	DefaultServerURL = "https://baked.example:8443"
	t.Cleanup(func() { DefaultServerURL = old })
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Chdir(t.TempDir())

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "https://baked.example:8443" {
		t.Fatalf("server url: %s", cfg.ServerURL)
	}
	if cfg.EnrollmentSecret != "" {
		t.Fatalf("expected empty secret, got %q", cfg.EnrollmentSecret)
	}
	if cfg.Enrolled() {
		t.Fatal("not enrolled")
	}
}

func TestIgnoreExeDirGoBuild(t *testing.T) {
	if !ignoreExeDir(`C:\Users\me\AppData\Local\go-build\123\exe\agent.exe`) {
		t.Fatal("expected go-build exe dir to be ignored")
	}
	if ignoreExeDir(`C:\Program Files\PC Manager Agent\pc-manager-agent.exe`) {
		t.Fatal("installed exe dir should be used")
	}
}

func TestEmptyDataDirKeepsHomeDefault(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	cfgDir := filepath.Join(root, "apps", "agent")
	if err := os.MkdirAll(filepath.Join(cfgDir, "cmd", "agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	yaml := "server_url: http://example:4000\nenrollment_secret: test-secret-value\ndata_dir: \"\"\n"
	if err := os.WriteFile(filepath.Join(cfgDir, "config.yaml"), []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("PC_MANAGER_CONFIG", "")
	isolateRegistry(t)
	t.Chdir(filepath.Join(cfgDir, "cmd", "agent"))

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "http://example:4000" {
		t.Fatalf("server url: %s", cfg.ServerURL)
	}
	want := filepath.Join(home, ".pc-manager")
	if cfg.DataDir != want {
		t.Fatalf("data_dir=%q want default %q", cfg.DataDir, want)
	}
	if !strings.HasSuffix(cfg.Path(), "config.yaml") {
		t.Fatalf("config path: %s", cfg.Path())
	}
	if len(cfg.Tried()) == 0 {
		t.Fatal("expected tried paths")
	}
}

func TestWalkUpFindsParentConfig(t *testing.T) {
	start := filepath.Join(t.TempDir(), "a", "b", "c")
	if err := os.MkdirAll(start, 0o755); err != nil {
		t.Fatal(err)
	}
	found := walkUp(start, "config.yaml")
	if len(found) < 3 {
		t.Fatalf("walk: %v", found)
	}
	if !strings.HasSuffix(found[0], filepath.Join("c", "config.yaml")) {
		t.Fatalf("first candidate: %s", found[0])
	}
}

func TestStripBOM(t *testing.T) {
	got := stripBOM(append(append([]byte{}, utf8BOM...), []byte("server_url: http://x")...))
	if strings.HasPrefix(string(got), "\ufeff") {
		t.Fatal("bom remains")
	}
	if string(got) != "server_url: http://x" {
		t.Fatalf("got %q", got)
	}
}

func TestMergeSidecarYAMLFillsSecret(t *testing.T) {
	dir := t.TempDir()
	sidecar := filepath.Join(dir, "pack.yaml")
	dest := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(sidecar, append(append([]byte{}, utf8BOM...), []byte("server_url: https://pack.example\nenrollment_secret: pack-secret\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dest, []byte("server_url: http://localhost:4000\nenrollment_secret: \"\"\ndevice_id: already\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := MergeSidecarYAML(sidecar, dest); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	if !strings.Contains(body, "pack-secret") {
		t.Fatalf("expected pack secret in %s", body)
	}
	if !strings.Contains(body, "already") {
		t.Fatalf("expected existing device_id in %s", body)
	}
}

func TestMergeSidecarYAMLCopiesWhenMissing(t *testing.T) {
	dir := t.TempDir()
	sidecar := filepath.Join(dir, "pack.yaml")
	dest := filepath.Join(dir, "out", "config.yaml")
	if err := os.WriteFile(sidecar, []byte("server_url: https://pack.example\nenrollment_secret: pack-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := MergeSidecarYAML(sidecar, dest); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "pack-secret") {
		t.Fatalf("got %s", raw)
	}
}

func TestLoadStripsUTF8BOM(t *testing.T) {
	isolateStore(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	dir := t.TempDir()
	t.Chdir(dir)
	body := append(append([]byte{}, utf8BOM...), []byte("server_url: http://bom.example:4000\nenrollment_secret: bom-secret\n")...)
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "http://bom.example:4000" {
		t.Fatalf("server_url: %s", cfg.ServerURL)
	}
	if cfg.EnrollmentSecret != "bom-secret" {
		t.Fatalf("secret: %s", cfg.EnrollmentSecret)
	}
}
