//go:build windows

package credwin

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/pc-manager/agent/internal/winsession"
	"golang.org/x/sys/windows"
)

const (
	credTypeGeneric          = 1
	credTypeDomainPassword   = 2
	credTypeDomainVisible    = 4
	credPersistSession       = 1
	credPersistLocal         = 2
	credPersistEnterprise    = 3
	credEnumerateAll         = 0x1
)

type winCred struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        windows.Filetime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

var (
	modAdvapi             = windows.NewLazySystemDLL("advapi32.dll")
	procCredEnumerate     = modAdvapi.NewProc("CredEnumerateW")
	procCredRead          = modAdvapi.NewProc("CredReadW")
	procCredWrite         = modAdvapi.NewProc("CredWriteW")
	procCredDelete        = modAdvapi.NewProc("CredDeleteW")
	procCredFree          = modAdvapi.NewProc("CredFree")
)

func List(req ListRequest) (*ListResult, error) {
	sess := winsession.DescribeInteractiveSession()
	out := &ListResult{
		Credentials:     []Credential{},
		Revealed:        req.Reveal,
		SessionOk:       sess.SessionID != 0 && sess.ImpersonationOk,
		Session0:        winsession.InSession0(),
		SessionID:       sess.SessionID,
		SessionUser:     sess.Username,
		SessionState:    sess.State,
		ImpersonationOk: sess.ImpersonationOk,
	}
	if out.Session0 {
		out.Notes = append(out.Notes, "session0: agent is running as a service; user Credential Manager and Chromium DPAPI need a signed-in desktop session")
	}
	if sess.SessionID != 0 && !sess.ImpersonationOk {
		out.Notes = append(out.Notes, fmt.Sprintf("impersonation_failed: session %d (%s, %s) found but WTSQueryUserToken failed — agent may need LocalSystem", sess.SessionID, sess.Username, sess.State))
	}
	if !out.SessionOk && (req.Reveal || wants(req, "browser")) {
		out.NeedsSession = true
		out.Notes = append(out.Notes, "no_interactive_session: Chrome/Edge DPAPI and the user Credential Manager need a signed-in desktop session")
	}
	seen := map[string]bool{}
	add := func(c Credential) {
		if c.Target == "" {
			return
		}
		if c.Key == "" {
			c.Key = CredKey(c.Source, c.Target, c.Username)
		}
		if seen[c.Key] {
			return
		}
		seen[c.Key] = true
		if !req.Reveal {
			c.Secret = ""
		}
		if len(out.Credentials) >= maxCreds {
			out.Truncated = true
			return
		}
		out.Credentials = append(out.Credentials, c)
	}
	userCredsAdded := 0
	if wants(req, "windows") || wants(req, "apps") {
		if out.ImpersonationOk {
			impErr := winsession.RunInteractiveUser(func() error {
				for _, c := range enumerateCreds(req.Reveal) {
					c.Store = "user"
					if wants(req, "apps") && isAppCred(c) {
						c.Source = "apps"
					} else if wants(req, "windows") {
						c.Source = "windows"
					} else {
						continue
					}
					add(c)
					userCredsAdded++
				}
				return nil
			})
			if impErr != nil {
				out.ImpersonationOk = false
				out.SessionOk = false
				if req.Reveal {
					out.NeedsSession = true
				}
				out.Notes = append(out.Notes, "needs_interactive_session: could not impersonate the signed-in user for Credential Manager")
			}
		} else if req.Reveal && (wants(req, "windows") || wants(req, "apps")) {
			out.NeedsSession = true
		}
		for _, c := range enumerateCreds(req.Reveal) {
			if out.Session0 {
				c.Store = "system"
				if c.Comment == "" {
					c.Comment = "SYSTEM credential store (service session)"
				}
			} else if c.Store == "" {
				c.Store = "user"
			}
			if wants(req, "apps") && isAppCred(c) {
				c.Source = "apps"
			} else if wants(req, "windows") {
				c.Source = "windows"
			} else {
				continue
			}
			add(c)
		}
	}
	if wants(req, "browser") {
		var browser []Credential
		ranInteractive := false
		if out.ImpersonationOk {
			impErr := winsession.RunInteractiveUser(func() error {
				ranInteractive = true
				browser = browserCredentials(req.Reveal)
				return nil
			})
			if impErr != nil {
				out.ImpersonationOk = false
				out.SessionOk = false
				out.NeedsSession = true
				out.Notes = append(out.Notes, "needs_interactive_session: browser DPAPI/NSS requires a signed-in desktop user")
			}
		}
		if !ranInteractive {
			browser = browserCredentials(false)
			if req.Reveal {
				out.NeedsSession = true
				for i := range browser {
					if browser[i].Kind == "password" {
						browser[i].Locked = true
						if browser[i].Comment == "" {
							browser[i].Comment = "needs_interactive_session"
						}
					}
				}
				out.Notes = append(out.Notes, "needs_interactive_session: sign in on the desktop and retry with reveal/backup")
			}
		} else if req.Reveal {
			locked := 0
			for i := range browser {
				if browser[i].Locked || (browser[i].Secret == "" && browser[i].Kind == "password") {
					locked++
					if browser[i].Comment == "" && browser[i].Secret == "" {
						browser[i].Comment = "decrypt failed (wrong user, browser locked, or unsupported encryption)"
					}
				}
			}
			if locked > 0 {
				out.BrowserLocked = true
				out.Notes = append(out.Notes, "browser_locked: some passwords could not be decrypted — ensure the correct user is signed in and browsers are closed")
			}
		}
		for _, c := range browser {
			add(c)
		}
	}
	if wants(req, "apps") {
		for _, c := range appFileCredentials(req.Reveal) {
			add(c)
		}
	}
	if req.Reveal && out.ImpersonationOk && !out.BrowserLocked && (wants(req, "windows") || wants(req, "apps")) && !wants(req, "browser") {
		if userCredsAdded > 0 || !out.Session0 {
			out.NeedsSession = false
		}
	}
	tally(out)
	return out, nil
}

func Write(req WriteRequest) (*Credential, error) {
	if winsession.InSession0() && !winsession.HasConsoleUser() {
		return nil, ErrNoSession
	}
	typ := uint32(credTypeGeneric)
	persist := uint32(credPersistLocal)
	switch req.Persist {
	case "session":
		persist = credPersistSession
	case "enterprise":
		persist = credPersistEnterprise
	}
	target, err := syscall.UTF16PtrFromString(req.Target)
	if err != nil {
		return nil, err
	}
	var user *uint16
	if req.Username != "" {
		user, _ = syscall.UTF16PtrFromString(req.Username)
	}
	var comment *uint16
	if req.Comment != "" {
		comment, _ = syscall.UTF16PtrFromString(req.Comment)
	}
	blob := append([]byte(req.Secret), 0)
	cred := winCred{
		Type:               typ,
		TargetName:         target,
		Comment:            comment,
		CredentialBlobSize: uint32(len(req.Secret)),
		CredentialBlob:     &blob[0],
		Persist:            persist,
		UserName:           user,
	}
	var writeErr error
	ran := false
	impErr := winsession.RunInteractiveUser(func() error {
		ran = true
		r, _, e := procCredWrite.Call(uintptr(unsafe.Pointer(&cred)), 0)
		if r == 0 {
			writeErr = mapCredErr(e)
		}
		return nil
	})
	if impErr != nil {
		return nil, ErrNoSession
	}
	if !ran {
		return nil, ErrNoSession
	}
	if writeErr != nil {
		if !winsession.HasConsoleUser() && (errors.Is(writeErr, ErrAccessDenied) || winsession.InSession0()) {
			return nil, ErrNoSession
		}
		return nil, writeErr
	}
	return &Credential{
		Key:      CredKey(req.Source, req.Target, req.Username),
		Source:   req.Source,
		Kind:     "generic",
		Target:   req.Target,
		Username: req.Username,
		Persist:  persistName(persist),
		Comment:  req.Comment,
		Store:    "user",
	}, nil
}

func Delete(req DeleteRequest) (map[string]any, error) {
	if winsession.InSession0() && !winsession.HasConsoleUser() {
		return nil, ErrNoSession
	}
	target, err := syscall.UTF16PtrFromString(req.Target)
	if err != nil {
		return nil, err
	}
	typ := uint32(credTypeGeneric)
	if req.Kind == "domain" {
		typ = uint32(credTypeDomainPassword)
	}
	var delErr error
	ran := false
	impErr := winsession.RunInteractiveUser(func() error {
		ran = true
		r, _, e := procCredDelete.Call(uintptr(unsafe.Pointer(target)), uintptr(typ), 0)
		if r == 0 {
			delErr = mapCredErr(e)
		}
		return nil
	})
	if impErr != nil {
		return nil, ErrNoSession
	}
	if !ran {
		return nil, ErrNoSession
	}
	if delErr != nil {
		if !winsession.HasConsoleUser() && (errors.Is(delErr, ErrAccessDenied) || winsession.InSession0()) {
			return nil, ErrNoSession
		}
		return nil, delErr
	}
	return map[string]any{"deleted": true, "target": req.Target}, nil
}

func Restore(req RestoreRequest) (map[string]any, error) {
	restored := 0
	failed := 0
	var notes []string
	for _, item := range req.Credentials {
		if strings.EqualFold(item.Source, "browser") {
			failed++
			if len(notes) < 8 {
				notes = append(notes, item.Target+": browser NSS/DPAPI restore is not supported")
			}
			continue
		}
		if _, err := Write(item); err != nil {
			failed++
			if len(notes) < 8 {
				notes = append(notes, item.Target+": "+err.Error())
			}
			continue
		}
		restored++
	}
	return map[string]any{
		"restored": restored,
		"failed":   failed,
		"notes":    notes,
		"sessionOk": winsession.HasConsoleUser(),
	}, nil
}

func enumerateCreds(reveal bool) []Credential {
	var count uint32
	var list **winCred
	r, _, _ := procCredEnumerate.Call(0, credEnumerateAll, uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&list)))
	if r == 0 || list == nil || count == 0 {
		return nil
	}
	defer procCredFree.Call(uintptr(unsafe.Pointer(list)))
	ptrs := unsafe.Slice(list, int(count))
	out := make([]Credential, 0, len(ptrs))
	for _, p := range ptrs {
		if p == nil {
			continue
		}
		c := credFromWin(p, reveal)
		if c.Target != "" {
			out = append(out, c)
		}
	}
	return out
}

func credFromWin(p *winCred, reveal bool) Credential {
	target := windows.UTF16PtrToString(p.TargetName)
	user := windows.UTF16PtrToString(p.UserName)
	c := Credential{
		Key:         CredKey("windows", target, user),
		Source:      "windows",
		Kind:        credTypeName(p.Type),
		Target:      target,
		Username:    user,
		Persist:     persistName(p.Persist),
		Comment:     windows.UTF16PtrToString(p.Comment),
		LastWritten: filetimeRFC3339(p.LastWritten),
	}
	if reveal && p.CredentialBlob != nil && p.CredentialBlobSize > 0 {
		b := unsafe.Slice(p.CredentialBlob, int(p.CredentialBlobSize))
		c.Secret = strings.TrimRight(string(b), "\x00")
		if looksUTF16(b) {
			u16 := make([]uint16, len(b)/2)
			for i := range u16 {
				u16[i] = binary.LittleEndian.Uint16(b[i*2:])
			}
			c.Secret = strings.TrimRight(windows.UTF16ToString(u16), "\x00")
		}
	}
	return c
}

func looksUTF16(b []byte) bool {
	if len(b) < 4 || len(b)%2 != 0 {
		return false
	}
	zeros := 0
	for i := 1; i < len(b); i += 2 {
		if b[i] == 0 {
			zeros++
		}
	}
	return zeros >= len(b)/4
}

func credTypeName(v uint32) string {
	switch v {
	case credTypeGeneric:
		return "generic"
	case credTypeDomainPassword:
		return "domain"
	case credTypeDomainVisible:
		return "visible"
	default:
		return "other"
	}
}

func persistName(v uint32) string {
	switch v {
	case credPersistSession:
		return "session"
	case credPersistEnterprise:
		return "enterprise"
	default:
		return "local"
	}
}

func filetimeRFC3339(ft windows.Filetime) string {
	if ft.LowDateTime == 0 && ft.HighDateTime == 0 {
		return ""
	}
	t := time.Unix(0, ft.Nanoseconds()).UTC()
	if t.Year() < 2000 {
		return ""
	}
	return t.Format(time.RFC3339)
}

func isAppCred(c Credential) bool {
	t := strings.ToLower(c.Target)
	return strings.Contains(t, "git:") ||
		strings.Contains(t, "github.com") ||
		strings.Contains(t, "gitlab") ||
		strings.Contains(t, "bitbucket") ||
		strings.Contains(t, "microsoft_") ||
		strings.Contains(t, "microsoftaccount") ||
		strings.Contains(t, "teams") ||
		strings.Contains(t, "outlook") ||
		strings.Contains(t, "office") ||
		strings.Contains(t, "onedrive") ||
		strings.Contains(t, "npm") ||
		strings.Contains(t, "yarn") ||
		strings.Contains(t, "pnpm") ||
		strings.Contains(t, "docker") ||
		strings.Contains(t, "vscode") ||
		strings.Contains(t, "vs code") ||
		strings.Contains(t, "azure") ||
		strings.Contains(t, "aws") ||
		strings.Contains(t, "putty") ||
		strings.Contains(t, "winscp") ||
		strings.Contains(t, "ssh:") ||
		strings.Contains(t, "legacygeneric")
}

func mapCredErr(err error) error {
	if err == nil {
		return ErrAccessDenied
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch errno {
		case windows.ERROR_NOT_FOUND, windows.ERROR_FILE_NOT_FOUND:
			return ErrNotFound
		case windows.ERROR_ACCESS_DENIED:
			return ErrAccessDenied
		}
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "not found") {
		return ErrNotFound
	}
	if strings.Contains(msg, "access") {
		return ErrAccessDenied
	}
	return err
}
