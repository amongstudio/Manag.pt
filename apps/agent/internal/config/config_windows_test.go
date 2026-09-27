//go:build windows

package config

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows/registry"
)

func isolateRegistry(t *testing.T) {
	t.Helper()
	origM, origU := machineKeyPath, userKeyPath
	key := `SOFTWARE\PCManagerAgentTest\` + sanitizeKey(t.Name())
	machineKeyPath = key
	userKeyPath = key
	t.Cleanup(func() {
		deleteKeyPath(registry.CURRENT_USER, key)
		deleteKeyPath(registry.LOCAL_MACHINE, key)
		parent := `SOFTWARE\PCManagerAgentTest`
		deleteKeyPath(registry.CURRENT_USER, parent)
		deleteKeyPath(registry.LOCAL_MACHINE, parent)
		machineKeyPath = origM
		userKeyPath = origU
	})
}

func sanitizeKey(name string) string {
	out := make([]rune, 0, len(name))
	for _, r := range name {
		if r == '/' || r == '\\' || r == ' ' {
			out = append(out, '_')
			continue
		}
		out = append(out, r)
	}
	return string(out)
}

func TestRegistryRoundTripHKCU(t *testing.T) {
	isolateRegistry(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("PC_MANAGER_CONFIG", "")
	t.Setenv("SERVER_URL", "")
	t.Setenv("ENROLLMENT_SECRET", "")
	t.Chdir(t.TempDir())

	cfg := Default()
	cfg.ServerURL = "https://fleet.example:8443"
	cfg.EnrollmentSecret = "secret-value"
	cfg.DeviceID = "dev-1"
	cfg.DeviceKey = "key-1"
	cfg.FallbackURLs = []string{"https://b.example"}
	cfg.HeartbeatIntervalSec = 42
	cfg.EnableWebrtc = true
	cfg.store = storeRegistry
	if err := saveToStore(&cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.registryRoot == "" {
		t.Fatal("expected registry root")
	}

	loaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.UsingRegistry() {
		t.Fatalf("store: path %s", loaded.Path())
	}
	if loaded.ServerURL != "https://fleet.example:8443" {
		t.Fatalf("server_url: %s", loaded.ServerURL)
	}
	if loaded.EnrollmentSecret != "secret-value" {
		t.Fatal("enrollment_secret")
	}
	if loaded.DeviceID != "dev-1" || loaded.DeviceKey != "key-1" {
		t.Fatalf("device %s %s", loaded.DeviceID, loaded.DeviceKey)
	}
	if len(loaded.FallbackURLs) != 1 || loaded.FallbackURLs[0] != "https://b.example" {
		t.Fatalf("fallback: %v", loaded.FallbackURLs)
	}
	if loaded.HeartbeatIntervalSec != 42 {
		t.Fatalf("heartbeat: %d", loaded.HeartbeatIntervalSec)
	}
	if !loaded.EnableWebrtc {
		t.Fatal("enable_webrtc")
	}
}

func TestYAMLWinsOverRegistry(t *testing.T) {
	isolateRegistry(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("SERVER_URL", "")
	t.Setenv("ENROLLMENT_SECRET", "")
	dir := t.TempDir()
	t.Chdir(dir)
	yamlPath := filepath.Join(dir, "config.yaml")
	body := "server_url: http://from-yaml:4000\nenrollment_secret: yaml-secret\n"
	if err := os.WriteFile(yamlPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PC_MANAGER_CONFIG", yamlPath)

	cfg := Default()
	cfg.ServerURL = "https://from-registry"
	cfg.store = storeRegistry
	if err := saveToStore(&cfg); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.UsingRegistry() {
		t.Fatal("yaml should win")
	}
	if loaded.ServerURL != "http://from-yaml:4000" {
		t.Fatalf("server_url: %s", loaded.ServerURL)
	}
	if loaded.EnrollmentSecret != "yaml-secret" {
		t.Fatalf("secret: %s", loaded.EnrollmentSecret)
	}
}

func TestMigrateUserToMachineFillsGaps(t *testing.T) {
	isolateRegistry(t)
	user := registryValues{
		present:          map[string]bool{"enrollment_secret": true, "device_id": true, "device_key": true, "server_url": true},
		ServerURL:        "https://user.example",
		EnrollmentSecret: "user-secret",
		DeviceID:         "id-user",
		DeviceKey:        "key-user",
	}
	if err := writeHive(registry.CURRENT_USER, userKeyPath, user); err != nil {
		t.Fatal(err)
	}
	machine := registryValues{
		present:   map[string]bool{"server_url": true},
		ServerURL: "https://machine.example",
	}
	if err := writeHive(registry.LOCAL_MACHINE, machineKeyPath, machine); err != nil {
		t.Skip("HKLM write requires elevation")
	}
	if err := MigrateUserToMachine(); err != nil {
		t.Fatal(err)
	}
	got, ok := readHive(registry.LOCAL_MACHINE, machineKeyPath)
	if !ok {
		t.Fatal("expected HKLM after migrate")
	}
	if got.ServerURL != "https://machine.example" {
		t.Fatalf("machine url should win: %s", got.ServerURL)
	}
	if got.EnrollmentSecret != "user-secret" || got.DeviceID != "id-user" || got.DeviceKey != "key-user" {
		t.Fatalf("expected user secrets copied: %+v", got)
	}
}
