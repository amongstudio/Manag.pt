//go:build windows

package winsession

import (
	"fmt"
	"sort"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	invalidSessionID = 0xFFFFFFFF
	desktopName      = "winsta0\\default"
	wtsUserName      = 5
)

var (
	modWtsapi                       = windows.NewLazySystemDLL("wtsapi32.dll")
	procWTSQuerySessionInformationW = modWtsapi.NewProc("WTSQuerySessionInformationW")
)

func InSession0() bool {
	var sid uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &sid); err != nil {
		return false
	}
	return sid == 0
}

func HasConsoleUser() bool {
	_, err := ActiveSessionID()
	return err == nil
}

func ConsoleUserProfile() string {
	tok, err := ImpersonationToken()
	if err != nil {
		return ""
	}
	defer tok.Close()
	return UserProfileDir(tok)
}

func DescribeInteractiveSession() InteractiveSession {
	sid, err := ActiveSessionID()
	if err != nil {
		return InteractiveSession{}
	}
	info := lookupSession(sid)
	out := InteractiveSession{
		SessionID: sid,
		Username:  info.username,
		State:     sessionStateName(info.state),
	}
	var tok windows.Token
	if windows.WTSQueryUserToken(sid, &tok) == nil {
		out.ImpersonationOk = true
		tok.Close()
	}
	return out
}

func ActiveSessionID() (uint32, error) {
	// WTSQueryUserToken requires SeTcbPrivilege when called from a service.
	// LocalSystem owns the privilege, but it is not guaranteed to be enabled
	// in every service process token.
	_ = enableProcessPrivilege("SeTcbPrivilege")
	for _, sid := range candidateSessionIDs() {
		var tok windows.Token
		if err := windows.WTSQueryUserToken(sid, &tok); err != nil {
			continue
		}
		tok.Close()
		return sid, nil
	}
	return 0, ErrNoInteractiveSession
}

func candidateSessionIDs() []uint32 {
	var list *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &list, &count); err != nil || count == 0 || list == nil {
		return fallbackConsoleSession()
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(list)))
	infos := unsafe.Slice(list, count)
	cands := make([]sessionCandidate, 0, len(infos))
	for _, s := range infos {
		if s.SessionID == 0 {
			continue
		}
		user := querySessionUsername(s.SessionID)
		if user == "" {
			continue
		}
		cands = append(cands, sessionCandidate{id: s.SessionID, state: s.State, username: user})
	}
	sort.SliceStable(cands, func(i, j int) bool {
		pi := sessionStatePriority(cands[i].state)
		pj := sessionStatePriority(cands[j].state)
		if pi != pj {
			return pi < pj
		}
		return cands[i].id < cands[j].id
	})
	ids := make([]uint32, 0, len(cands))
	for _, cand := range cands {
		if sessionStatePriority(cand.state) >= 0 {
			ids = append(ids, cand.id)
		}
	}
	if len(ids) > 0 {
		return ids
	}
	return fallbackConsoleSession()
}

func enableProcessPrivilege(name string) error {
	proc, err := windows.GetCurrentProcess()
	if err != nil {
		return err
	}
	var token windows.Token
	if err := windows.OpenProcessToken(proc, windows.TOKEN_QUERY|windows.TOKEN_ADJUST_PRIVILEGES, &token); err != nil {
		return err
	}
	defer token.Close()
	privilege, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, privilege, &luid); err != nil {
		return err
	}
	state := windows.Tokenprivileges{PrivilegeCount: 1}
	state.Privileges[0] = windows.LUIDAndAttributes{
		Luid:       luid,
		Attributes: windows.SE_PRIVILEGE_ENABLED,
	}
	return windows.AdjustTokenPrivileges(token, false, &state, 0, nil, nil)
}

func fallbackConsoleSession() []uint32 {
	id := windows.WTSGetActiveConsoleSessionId()
	if id != invalidSessionID && id != 0 {
		return []uint32{id}
	}
	return nil
}

func lookupSession(id uint32) sessionCandidate {
	var list *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &list, &count); err != nil || list == nil {
		return sessionCandidate{id: id, username: querySessionUsername(id)}
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(list)))
	for _, s := range unsafe.Slice(list, count) {
		if s.SessionID == id {
			return sessionCandidate{id: id, state: s.State, username: querySessionUsername(id)}
		}
	}
	return sessionCandidate{id: id, username: querySessionUsername(id)}
}

func querySessionUsername(sessionID uint32) string {
	var buf *uint16
	var n uint32
	r, _, _ := procWTSQuerySessionInformationW.Call(
		0,
		uintptr(sessionID),
		uintptr(wtsUserName),
		uintptr(unsafe.Pointer(&buf)),
		uintptr(unsafe.Pointer(&n)),
	)
	if r == 0 || buf == nil {
		return ""
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(buf)))
	return windows.UTF16PtrToString(buf)
}

func ImpersonationToken() (windows.Token, error) {
	sid, err := ActiveSessionID()
	if err != nil {
		return 0, err
	}
	var tok windows.Token
	if err := windows.WTSQueryUserToken(sid, &tok); err != nil {
		return 0, fmt.Errorf("%w: WTSQueryUserToken(session %d): %v", ErrNoInteractiveSession, sid, err)
	}
	return tok, nil
}

func PrimaryUserToken() (windows.Token, error) {
	imp, err := ImpersonationToken()
	if err != nil {
		return 0, err
	}
	defer imp.Close()
	var primary windows.Token
	if err := windows.DuplicateTokenEx(imp, windows.TOKEN_ALL_ACCESS, nil, windows.SecurityImpersonation, windows.TokenPrimary, &primary); err != nil {
		return 0, fmt.Errorf("%w: DuplicateTokenEx: %v", ErrNoInteractiveSession, err)
	}
	return primary, nil
}

// LaunchInSession starts exe on the interactive desktop. Session 0 uses
// CreateProcessAsUser (needs SeTcbPrivilege / LocalSystem). An already
// interactive process (go run, console) uses CreateProcess with its own token.
func LaunchInSession(exe, cmdline string, si *windows.StartupInfo, inherit bool, flags uint32) (*windows.ProcessInformation, error) {
	if InSession0() {
		token, err := PrimaryUserToken()
		if err != nil {
			return nil, err
		}
		defer token.Close()
		return StartUserProcess(token, exe, cmdline, si, inherit, flags)
	}
	return StartCurrentProcess(exe, cmdline, si, inherit, flags)
}

func StartCurrentProcess(exe, cmdline string, si *windows.StartupInfo, inherit bool, flags uint32) (*windows.ProcessInformation, error) {
	app, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return nil, err
	}
	cmd, err := windows.UTF16PtrFromString(cmdline)
	if err != nil {
		return nil, err
	}
	si = withDesktop(si)
	var pi windows.ProcessInformation
	if err := windows.CreateProcess(app, cmd, nil, nil, inherit, flags, nil, nil, si, &pi); err != nil {
		return nil, err
	}
	return &pi, nil
}

func withDesktop(si *windows.StartupInfo) *windows.StartupInfo {
	if si == nil {
		s := windows.StartupInfo{
			Cb:         uint32(unsafe.Sizeof(windows.StartupInfo{})),
			Flags:      windows.STARTF_USESHOWWINDOW,
			ShowWindow: windows.SW_HIDE,
		}
		desk, _ := windows.UTF16PtrFromString(desktopName)
		s.Desktop = desk
		return &s
	}
	if si.Desktop == nil {
		desk, _ := windows.UTF16PtrFromString(desktopName)
		si.Desktop = desk
	}
	return si
}

func UserProfileDir(token windows.Token) string {
	var n uint32 = 260
	for {
		buf := make([]uint16, n)
		err := windows.GetUserProfileDirectory(token, &buf[0], &n)
		if err == nil {
			return windows.UTF16ToString(buf)
		}
		if err != windows.ERROR_INSUFFICIENT_BUFFER {
			return ""
		}
		if n <= uint32(len(buf)) {
			return ""
		}
	}
}

func DesktopName() string { return desktopName }

func StartUserProcess(token windows.Token, exe, cmdline string, si *windows.StartupInfo, inherit bool, flags uint32) (*windows.ProcessInformation, error) {
	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, token, false); err == nil && env != nil {
		defer windows.DestroyEnvironmentBlock(env)
		flags |= windows.CREATE_UNICODE_ENVIRONMENT
	}
	app, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return nil, err
	}
	cmd, err := windows.UTF16PtrFromString(cmdline)
	if err != nil {
		return nil, err
	}
	var dir *uint16
	if p := UserProfileDir(token); p != "" {
		dir, _ = windows.UTF16PtrFromString(p)
	}
	si = withDesktop(si)
	var pi windows.ProcessInformation
	if err := windows.CreateProcessAsUser(token, app, cmd, nil, nil, inherit, flags, env, dir, si, &pi); err != nil {
		return nil, err
	}
	return &pi, nil
}
