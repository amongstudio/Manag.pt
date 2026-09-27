package credwin

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

var (
	errNoEncryptedKey = errors.New("no encrypted_key in Local State")
	errShortCiphertext = errors.New("ciphertext too short")
)

// chromiumSpec describes a Chromium-family browser user-data root.
type chromiumSpec struct {
	Name string
	Dir  string
}

// ParseLocalStateEncryptedKey extracts the base64 os_crypt.encrypted_key payload
// from a Chromium Local State JSON file (before DPAPI unwrap).
func ParseLocalStateEncryptedKey(raw []byte) ([]byte, error) {
	var body struct {
		OsCrypt struct {
			EncryptedKey string `json:"encrypted_key"`
		} `json:"os_crypt"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	if body.OsCrypt.EncryptedKey == "" {
		return nil, errNoEncryptedKey
	}
	bin, err := base64.StdEncoding.DecodeString(body.OsCrypt.EncryptedKey)
	if err != nil {
		return nil, err
	}
	return bytes.TrimPrefix(bin, []byte("DPAPI")), nil
}

// UnwrapChromiumMasterKey applies DPAPI to the encrypted_key blob from Local State.
func UnwrapChromiumMasterKey(localStateRaw []byte, dpapi func([]byte) ([]byte, error)) ([]byte, error) {
	enc, err := ParseLocalStateEncryptedKey(localStateRaw)
	if err != nil {
		return nil, err
	}
	if dpapi == nil {
		return nil, errors.New("dpapi required")
	}
	return dpapi(enc)
}

var chromiumProfileRe = regexp.MustCompile(`^(Default|Profile(\s+\d+)?)$`)

// IsChromiumLoginProfile matches Python Browser.py profile folders (Default, Profile N).
func IsChromiumLoginProfile(name string) bool {
	return chromiumProfileRe.MatchString(strings.TrimSpace(name))
}

// DecryptChromiumPassword decrypts a Chromium password_value blob using the
// DPAPI-unwrapped master key (v10/v11 AES-GCM) or legacy DPAPI.
func DecryptChromiumPassword(blob, masterKey []byte, dpapi func([]byte) ([]byte, error)) (string, error) {
	if len(blob) == 0 {
		return "", nil
	}
	if bytes.HasPrefix(blob, []byte("v10")) || bytes.HasPrefix(blob, []byte("v11")) {
		if len(masterKey) == 0 {
			return "", errors.New("missing master key for v10/v11")
		}
		plain, err := decryptAESGCM(masterKey, blob[3:3+12], blob[3+12:])
		if err != nil {
			// Python Browser.py style: IV at [3:15], ciphertext at [15:-16].
			if alt, altErr := decryptChromiumPasswordPython(blob, masterKey); altErr == nil {
				return alt, nil
			}
			return "", err
		}
		return string(plain), nil
	}
	if bytes.HasPrefix(blob, []byte("v20")) {
		return "", errors.New("app-bound encryption (v20) is not supported")
	}
	if dpapi == nil {
		return "", errors.New("dpapi required for legacy blob")
	}
	plain, err := dpapi(blob)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func decryptChromiumPasswordPython(blob, masterKey []byte) (string, error) {
	if len(blob) < 15+16 {
		return "", errShortCiphertext
	}
	nonce := blob[3:15]
	body := blob[15:]
	if len(body) < 16 {
		return "", errShortCiphertext
	}
	ciphertext := body[:len(body)-16]
	tag := body[len(body)-16:]
	sealed := append(append([]byte(nil), ciphertext...), tag...)
	plain, err := decryptAESGCM(masterKey, nonce, sealed)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func decryptAESGCM(key, nonce, ciphertext []byte) ([]byte, error) {
	if len(key) == 0 {
		return nil, errors.New("empty key")
	}
	if len(nonce) != 12 {
		return nil, errors.New("invalid nonce length")
	}
	if len(ciphertext) < 16 {
		return nil, errShortCiphertext
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ciphertext, nil)
}

// isChromiumProfileDir reports whether dir looks like a Chromium profile folder.
func isChromiumProfileDir(name string) bool {
	n := strings.TrimSpace(name)
	if n == "" {
		return false
	}
	switch strings.ToLower(n) {
	case "system profile", "guest profile", "crashpad", "shadercache", "grshadercache",
		"browsermetrics", "optimizationguidepredictionmodels", "widevinecdm",
		"recovery-improved", "pnacl", "swiftshader", "default-secure-preferences":
		return false
	}
	if strings.HasPrefix(n, "Crashpad") || strings.HasPrefix(n, "MEIPreload") {
		return false
	}
	return true
}

func dedupeBrowserCreds(in []Credential) []Credential {
	seen := map[string]bool{}
	out := make([]Credential, 0, len(in))
	for _, c := range in {
		key := c.Key
		if key == "" {
			key = browserCredKey(c.Browser, c.Profile, c.Target, c.Username)
			c.Key = key
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, c)
	}
	return out
}

func browserCredKey(browser, profile, origin, username string) string {
	return strings.ToLower("browser|" + browser + "|" + profile + "|" + origin + "|" + username)
}
