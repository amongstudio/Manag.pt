//go:build windows

package credwin

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type secItem struct {
	Type uint32
	Data *byte
	Len  int32
}

var (
	nss3               *windows.LazyDLL
	nssInit            *windows.LazyProc
	nssShutdown        *windows.LazyProc
	pk11GetInternalKeySlot *windows.LazyProc
	pk11FreeSlot       *windows.LazyProc
	pk11Authenticate   *windows.LazyProc
	pk11SDRDecrypt     *windows.LazyProc
)

func firefoxCredentials(spec firefoxSpec, reveal bool) []Credential {
	entries, err := os.ReadDir(spec.Dir)
	if err != nil {
		return nil
	}
	var out []Credential
	for _, p := range entries {
		if !p.IsDir() {
			continue
		}
		profileDir := filepath.Join(spec.Dir, p.Name())
		loginsPath := filepath.Join(profileDir, "logins.json")
		raw, err := os.ReadFile(loginsPath)
		if err != nil {
			continue
		}
		rows := parseFirefoxLoginsFile(raw, spec.Name, p.Name(), reveal, profileDir)
		out = append(out, rows...)
		if len(out) >= maxCreds {
			return out
		}
	}
	return out
}

func parseFirefoxLoginsFile(raw []byte, browser, profile string, reveal bool, profileDir string) []Credential {
	var body struct {
		Logins []struct {
			Hostname          string `json:"hostname"`
			EncryptedUsername string `json:"encryptedUsername"`
			EncryptedPassword string `json:"encryptedPassword"`
			GUID              string `json:"guid"`
			TimesUsed         int    `json:"timesUsed"`
			TimeLastUsed      int64  `json:"timeLastUsed"`
			TimeCreated       int64  `json:"timeCreated"`
		} `json:"logins"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return nil
	}

	var nssReady bool
	var nssErr error
	if reveal {
		nssErr = initNSS(profileDir)
		nssReady = nssErr == nil
		if nssReady {
			defer nssShutdown.Call()
		}
	}

	out := make([]Credential, 0, len(body.Logins))
	for _, row := range body.Logins {
		host := strings.TrimSpace(row.Hostname)
		if host == "" {
			continue
		}
		userKey := row.GUID
		if userKey == "" {
			userKey = row.EncryptedUsername
		}
		c := Credential{
			Key:      browserCredKey(browser, profile, host, userKey),
			Source:   "browser",
			Kind:     "password",
			Target:   host,
			Browser:  browser,
			Profile:  profile,
		}
		if row.TimesUsed > 0 {
			c.Comment = "used " + strconv.Itoa(row.TimesUsed) + "x"
		}
		if ts := firefoxTime(row.TimeLastUsed); ts != "" {
			c.LastWritten = ts
		} else if ts := firefoxTime(row.TimeCreated); ts != "" {
			c.LastWritten = ts
		}

		if !reveal {
			out = append(out, c)
			continue
		}
		if !nssReady {
			c.Locked = true
			if nssErr != nil {
				c.Comment = nssErr.Error()
			} else {
				c.Comment = "NSS unavailable"
			}
			out = append(out, c)
			continue
		}
		user, err := nssDecryptString(row.EncryptedUsername)
		if err != nil {
			c.Locked = true
			c.Comment = "username decrypt: " + err.Error()
			out = append(out, c)
			continue
		}
		c.Username = user
		secret, err := nssDecryptString(row.EncryptedPassword)
		if err != nil {
			c.Locked = true
			c.Comment = "password decrypt: " + err.Error()
			out = append(out, c)
			continue
		}
		c.Secret = secret
		if c.Secret == "" {
			c.Locked = true
		}
		out = append(out, c)
	}
	return out
}

func initNSS(profileDir string) error {
	libDir, err := findNSSLibDir()
	if err != nil {
		return err
	}
	oldPath := os.Getenv("PATH")
	os.Setenv("PATH", libDir+string(os.PathListSeparator)+oldPath)
	defer os.Setenv("PATH", oldPath)

	nss3 = windows.NewLazyDLL(filepath.Join(libDir, "nss3.dll"))
	nssInit = nss3.NewProc("NSS_Init")
	nssShutdown = nss3.NewProc("NSS_Shutdown")
	pk11GetInternalKeySlot = nss3.NewProc("PK11_GetInternalKeySlot")
	pk11FreeSlot = nss3.NewProc("PK11_FreeSlot")
	pk11Authenticate = nss3.NewProc("PK11_Authenticate")
	pk11SDRDecrypt = nss3.NewProc("PK11SDR_Decrypt")
	if err := nss3.Load(); err != nil {
		return err
	}

	profilePtr, err := syscall.BytePtrFromString(profileDir)
	if err != nil {
		return err
	}
	ret, _, _ := nssInit.Call(uintptr(unsafe.Pointer(profilePtr)))
	if ret != 0 {
		return errors.New("NSS_Init failed (master password set or key4.db locked)")
	}

	slot, _, _ := pk11GetInternalKeySlot.Call()
	if slot == 0 {
		return errors.New("PK11_GetInternalKeySlot failed")
	}
	defer pk11FreeSlot.Call(slot)
	auth, _, _ := pk11Authenticate.Call(slot, 1, 0)
	if auth != 0 {
		return errors.New("Firefox master password required")
	}
	return nil
}

func nssDecryptString(ciphertext string) (string, error) {
	if strings.TrimSpace(ciphertext) == "" {
		return "", nil
	}
	raw, err := decodeFirefoxCipher(ciphertext)
	if err != nil {
		return "", err
	}
	if len(raw) == 0 {
		return "", nil
	}
	in := secItem{Data: &raw[0], Len: int32(len(raw))}
	var out secItem
	ret, _, _ := pk11SDRDecrypt.Call(uintptr(unsafe.Pointer(&in)), uintptr(unsafe.Pointer(&out)), 0)
	if ret != 0 || out.Data == nil || out.Len <= 0 {
		return "", errors.New("PK11SDR_Decrypt failed")
	}
	plain := unsafe.Slice(out.Data, int(out.Len))
	return string(plain), nil
}

func decodeFirefoxCipher(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	return decodeBase64StdOrURL(s)
}

func findNSSLibDir() (string, error) {
	candidates := []string{
		filepath.Join(os.Getenv("ProgramFiles"), "Mozilla Firefox"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Mozilla Firefox"),
		filepath.Join(os.Getenv("ProgramFiles"), "Mozilla Firefox Developer Edition"),
		filepath.Join(os.Getenv("ProgramFiles"), "Waterfox"),
		filepath.Join(os.Getenv("ProgramFiles"), "LibreWolf"),
		filepath.Join(os.Getenv("LocalAppData"), "Waterfox", "Waterfox"),
	}
	for _, dir := range candidates {
		if dir == "" {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, "nss3.dll")); err == nil {
			return dir, nil
		}
	}
	return "", errors.New("nss3.dll not found (install Firefox/Waterfox for NSS decryption)")
}
