//go:build windows

package credwin

import (
	"os"
	"path/filepath"
	"testing"
)

func TestChromiumSpecsDiscovery(t *testing.T) {
	root := t.TempDir()
	local := filepath.Join(root, "AppData", "Local")
	roaming := filepath.Join(root, "AppData", "Roaming")
	chromeDir := filepath.Join(local, "Google", "Chrome", "User Data")
	if err := os.MkdirAll(filepath.Join(chromeDir, "Default"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(chromeDir, "Local State"), []byte(`{"os_crypt":{"encrypted_key":"abc"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(chromeDir, "Default", "Login Data"), []byte("SQLite"), 0o644); err != nil {
		t.Fatal(err)
	}
	specs := chromiumSpecs(local, roaming)
	found := false
	for _, s := range specs {
		if s.Name == "chrome" && filepath.Clean(s.Dir) == filepath.Clean(chromeDir) {
			found = true
		}
	}
	if !found {
		t.Fatalf("chrome spec not found: %+v", specs)
	}
}

func TestFirefoxSpecsDiscovery(t *testing.T) {
	root := t.TempDir()
	roaming := filepath.Join(root, "AppData", "Roaming")
	profiles := filepath.Join(roaming, "Mozilla", "Firefox", "Profiles", "abc.default")
	if err := os.MkdirAll(profiles, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profiles, "logins.json"), []byte(`{"logins":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	specs := firefoxSpecs(roaming)
	found := false
	for _, s := range specs {
		if s.Name == "firefox" {
			found = true
		}
	}
	if !found {
		t.Fatalf("firefox spec not found: %+v", specs)
	}
}

func TestScanSqliteBlobRoundTrip(t *testing.T) {
	blob := []byte("v10nonce ciphertext!!")
	serialType := int64(12 + 2*len(blob))
	val, sz := serialValueRaw(blob, serialType)
	b, ok := val.([]byte)
	if !ok || sz != len(blob) || string(b) != string(blob) {
		t.Fatalf("blob decode: %#v size=%d want=%d", val, sz, len(blob))
	}
}
