package credwin

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"errors"
	"testing"
)

func TestParseLocalStateEncryptedKey(t *testing.T) {
	keyMaterial := []byte("test-dpapi-blob")
	wrapped := append([]byte("DPAPI"), keyMaterial...)
	b64 := base64.StdEncoding.EncodeToString(wrapped)
	raw := []byte(`{"os_crypt":{"encrypted_key":"` + b64 + `"}}`)
	got, err := ParseLocalStateEncryptedKey(raw)
	if err != nil || !bytesEqual(got, keyMaterial) {
		t.Fatalf("parse: %q err=%v", got, err)
	}
	if _, err := ParseLocalStateEncryptedKey([]byte(`{"os_crypt":{}}`)); !errors.Is(err, errNoEncryptedKey) {
		t.Fatalf("missing key: %v", err)
	}
}

func TestDecryptChromiumPasswordV10(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	nonce := make([]byte, 12)
	for i := range nonce {
		nonce[i] = byte(i + 1)
	}
	plain := []byte("hunter2")
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	sealed := gcm.Seal(nil, nonce, plain, nil)
	blob := append(append([]byte("v10"), nonce...), sealed...)

	got, err := DecryptChromiumPassword(blob, key, nil)
	if err != nil || got != "hunter2" {
		t.Fatalf("decrypt: %q err=%v", got, err)
	}
}

func TestDecryptChromiumPasswordLegacyDPAPI(t *testing.T) {
	blob := []byte("legacy")
	got, err := DecryptChromiumPassword(blob, nil, func(data []byte) ([]byte, error) {
		return append([]byte(nil), data...), nil
	})
	if err != nil || got != "legacy" {
		t.Fatalf("legacy: %q err=%v", got, err)
	}
}

func TestDecryptChromiumPasswordV20Unsupported(t *testing.T) {
	_, err := DecryptChromiumPassword([]byte("v20\x00\x00"), make([]byte, 32), nil)
	if err == nil || err.Error() != "app-bound encryption (v20) is not supported" {
		t.Fatalf("v20: %v", err)
	}
}

func TestIsChromiumProfileDir(t *testing.T) {
	if !isChromiumProfileDir("Default") || !isChromiumProfileDir("Profile 3") {
		t.Fatal("expected profile dirs")
	}
	if isChromiumProfileDir("ShaderCache") || isChromiumProfileDir("Guest Profile") {
		t.Fatal("expected non-profile dirs")
	}
}

func TestIsChromiumLoginProfile(t *testing.T) {
	for _, name := range []string{"Default", "Profile", "Profile 1", "Profile 12"} {
		if !IsChromiumLoginProfile(name) {
			t.Fatalf("expected login profile %q", name)
		}
	}
	if IsChromiumLoginProfile("ShaderCache") || IsChromiumLoginProfile("Guest Profile") {
		t.Fatal("expected non-login profile dirs")
	}
}

func TestDecryptChromiumPasswordPythonLayout(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	nonce := make([]byte, 12)
	for i := range nonce {
		nonce[i] = byte(i + 1)
	}
	plain := []byte("secret")
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	sealed := gcm.Seal(nil, nonce, plain, nil)
	// Python layout: v10 + iv(12) + ciphertext + tag(16) as one blob
	blob := append(append([]byte("v10"), nonce...), sealed...)
	got, err := decryptChromiumPasswordPython(blob, key)
	if err != nil || got != "secret" {
		t.Fatalf("python layout: %q err=%v", got, err)
	}
}

func TestBrowserCredKeyDedupesProfiles(t *testing.T) {
	a := browserCredKey("chrome", "Default", "https://ex", "u")
	b := browserCredKey("chrome", "Profile 1", "https://ex", "u")
	if a == b {
		t.Fatal("profiles must produce distinct keys")
	}
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
