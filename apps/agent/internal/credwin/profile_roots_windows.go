//go:build windows

package credwin

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/pc-manager/agent/internal/winsession"
	"golang.org/x/sys/windows"
)

// activeUserProfileDir returns USERPROFILE for the current thread token when the
// agent is impersonating the signed-in desktop user (Session 0 service path).
func activeUserProfileDir() string {
	var tok windows.Token
	if err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &tok); err == nil {
		defer tok.Close()
		if p := winsession.UserProfileDir(tok); p != "" {
			return p
		}
	}
	proc, err := windows.GetCurrentProcess()
	if err != nil {
		return ""
	}
	if err := windows.OpenProcessToken(proc, windows.TOKEN_QUERY, &tok); err == nil {
		defer tok.Close()
		return winsession.UserProfileDir(tok)
	}
	return ""
}

// userProfileRootsForBrowser returns profile directories whose browser stores should
// be read. When decrypting (reveal), only the impersonated/console user is scanned
// so DPAPI master keys match the Login Data owner.
func userProfileRootsForBrowser(reveal bool) []string {
	seen := map[string]bool{}
	var roots []string
	add := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" {
			return
		}
		key := strings.ToLower(filepath.Clean(p))
		if seen[key] {
			return
		}
		if _, err := os.Stat(p); err != nil {
			return
		}
		seen[key] = true
		roots = append(roots, p)
	}

	if reveal || winsession.InSession0() {
		add(activeUserProfileDir())
		add(winsession.ConsoleUserProfile())
		if len(roots) > 0 {
			return roots
		}
	}

	add(activeUserProfileDir())
	if home, err := os.UserHomeDir(); err == nil {
		add(home)
	}
	add(winsession.ConsoleUserProfile())

	users := `C:\Users`
	entries, err := os.ReadDir(users)
	if err != nil {
		return roots
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		switch strings.ToLower(e.Name()) {
		case "public", "default", "default user", "all users":
			continue
		}
		add(filepath.Join(users, e.Name()))
	}
	return roots
}
