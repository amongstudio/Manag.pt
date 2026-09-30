package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestDefaultServiceName(t *testing.T) {
	name := DefaultAgentServiceName()
	if runtime.GOOS == "windows" && name != "PCManagerAgent" {
		t.Fatalf("windows service name: %s", name)
	}
	if runtime.GOOS != "windows" && name != "pc-manager-agent" {
		t.Fatalf("unix service name: %s", name)
	}
}

func TestApplyDefaults(t *testing.T) {
	cfg := Config{}
	cfg.applyDefaults()
	if cfg.StatusPort != 17890 {
		t.Fatalf("status port: %d", cfg.StatusPort)
	}
	if cfg.BackoffSec != 30 {
		t.Fatalf("backoff: %d", cfg.BackoffSec)
	}
	if cfg.FailThreshold != 3 {
		t.Fatalf("fail threshold: %d", cfg.FailThreshold)
	}
	if cfg.ProbeIntervalSec != 45 {
		t.Fatalf("probe interval: %d", cfg.ProbeIntervalSec)
	}
	if cfg.UpdateFile != "" {
		t.Fatalf("update_file should stay empty unless set, got %q", cfg.UpdateFile)
	}
	if cfg.AgentServiceName == "" {
		t.Fatal("missing agent service name")
	}
	if got, want := cfg.StatusURL(), "http://127.0.0.1:17890/status"; got != want {
		t.Fatalf("status url: %s", got)
	}
}

func TestExplicitZeroStartupGrace(t *testing.T) {
	cfg := Default()
	if err := yaml.Unmarshal([]byte("startup_grace_sec: 0\n"), &cfg); err != nil {
		t.Fatal(err)
	}
	cfg.applyDefaults()
	if cfg.StartupGraceSec != 0 {
		t.Fatalf("explicit zero grace became %d", cfg.StartupGraceSec)
	}
}

func TestProbeIntervalEnvOverridesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "helper.yaml")
	if err := os.WriteFile(path, []byte("probe_interval_sec: 45\nstartup_grace_sec: 60\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PC_MANAGER_HELPER_CONFIG", path)
	t.Setenv("HELPER_PROBE_INTERVAL_SEC", "12")
	t.Setenv("HELPER_STARTUP_GRACE_SEC", "0")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ProbeIntervalSec != 12 {
		t.Fatalf("probe interval %d", cfg.ProbeIntervalSec)
	}
	if cfg.StartupGraceSec != 0 {
		t.Fatalf("grace %d", cfg.StartupGraceSec)
	}
}

func TestNoSecretFields(t *testing.T) {
	raw, err := yaml.Marshal(Default())
	if err != nil {
		t.Fatal(err)
	}
	s := strings.ToLower(string(raw))
	for _, n := range []string{"enrollment", "device_key", "device_id"} {
		if strings.Contains(s, n) {
			t.Fatalf("helper config must not carry %q: %s", n, s)
		}
	}
}
