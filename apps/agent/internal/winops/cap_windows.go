//go:build windows

package winops

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	dismLogErrors    = 0
	dismOnlineImage  = "DISM_{53BC1236-4379-4EA8-9759-3CCB257C8196}"
	dismAlreadyInit  = 0xC142011C
	dismAccessDenied = 0x80070005
	dismAPITimeout   = 25 * time.Second
)

type dismCapability struct {
	Name  *uint16
	State uint32
	_     uint32
}

var (
	dismapi              = windows.NewLazySystemDLL("dismapi.dll")
	procDismInitialize   = dismapi.NewProc("DismInitialize")
	procDismOpenSession  = dismapi.NewProc("DismOpenSession")
	procDismGetCaps      = dismapi.NewProc("DismGetCapabilities")
	procDismDelete       = dismapi.NewProc("DismDelete")
	procDismCloseSession = dismapi.NewProc("DismCloseSession")
	procDismShutdown     = dismapi.NewProc("DismShutdown")
)

func Capabilities(req CapabilitiesRequest) (*CapabilityList, error) {
	var denied error
	if list, err := capabilitiesDISM(req); err == nil && list != nil && len(list.Capabilities) > 0 {
		return list, nil
	} else if err != nil && errors.Is(err, ErrDismAccessDenied) {
		denied = err
	}
	if rows := capabilitiesDismExe(req.Query); len(rows) > 0 {
		out := &CapabilityList{Capabilities: rows}
		if len(out.Capabilities) >= maxCapabilities {
			out.Truncated = true
		}
		return out, nil
	}
	if rows := capabilitiesPowerShell(req.Query); len(rows) > 0 {
		out := &CapabilityList{Capabilities: rows}
		if len(out.Capabilities) >= maxCapabilities {
			out.Truncated = true
		}
		return out, nil
	}
	if denied != nil {
		return nil, denied
	}
	return &CapabilityList{Capabilities: []WindowsCapability{}}, nil
}

func capabilitiesDISM(req CapabilitiesRequest) (*CapabilityList, error) {
	type ret struct {
		list *CapabilityList
		err  error
	}
	ch := make(chan ret, 1)
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				ch <- ret{err: fmt.Errorf("dism_panic: %v", rec)}
			}
		}()
		list, err := capabilitiesDISMInner(req)
		ch <- ret{list: list, err: err}
	}()
	select {
	case r := <-ch:
		return r.list, r.err
	case <-time.After(dismAPITimeout):
		return nil, errors.New("dism_timeout")
	}
}

func capabilitiesDISMInner(req CapabilitiesRequest) (*CapabilityList, error) {
	if err := dismapi.Load(); err != nil {
		return nil, ErrDismUnavailable
	}
	logPath, _ := syscall.UTF16PtrFromString(system32("..\\Temp\\pcmanager-dism.log"))
	r, _, _ := procDismInitialize.Call(dismLogErrors, uintptr(unsafe.Pointer(logPath)), 0)
	hr := uint32(r)
	if int32(r) < 0 && hr != dismAlreadyInit {
		return nil, mapDismHR(hr)
	}
	initialized := int32(r) >= 0
	online, err := syscall.UTF16PtrFromString(dismOnlineImage)
	if err != nil {
		if initialized {
			_, _, _ = procDismShutdown.Call()
		}
		return nil, err
	}
	var session uint32
	r, _, _ = procDismOpenSession.Call(uintptr(unsafe.Pointer(online)), 0, 0, uintptr(unsafe.Pointer(&session)))
	if int32(r) < 0 {
		if initialized {
			_, _, _ = procDismShutdown.Call()
		}
		return nil, mapDismHR(uint32(r))
	}
	defer func() {
		_, _, _ = procDismCloseSession.Call(uintptr(session))
		if initialized {
			_, _, _ = procDismShutdown.Call()
		}
	}()
	var caps *dismCapability
	var count uint32
	r, _, _ = procDismGetCaps.Call(uintptr(session), uintptr(unsafe.Pointer(&caps)), uintptr(unsafe.Pointer(&count)))
	if int32(r) < 0 {
		return nil, mapDismHR(uint32(r))
	}
	if caps != nil {
		defer procDismDelete.Call(uintptr(unsafe.Pointer(caps)))
	}
	out := &CapabilityList{Capabilities: []WindowsCapability{}}
	query := strings.ToLower(req.Query)
	for i := uint32(0); i < count; i++ {
		row := *(*dismCapability)(unsafe.Add(unsafe.Pointer(caps), uintptr(i)*unsafe.Sizeof(dismCapability{})))
		name := windows.UTF16PtrToString(row.Name)
		if name == "" {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(name), query) {
			continue
		}
		if len(out.Capabilities) >= maxCapabilities {
			out.Truncated = true
			break
		}
		out.Capabilities = append(out.Capabilities, WindowsCapability{
			Name:  name,
			State: capabilityStateName(row.State),
			Kind:  capabilityKind(name),
		})
	}
	return out, nil
}

func capabilitiesDismExe(query string) []WindowsCapability {
	raw, err := runCmdEnglish(90*time.Second, system32("dism.exe"), "/Online", "/English", "/Get-Capabilities")
	if err != nil && raw == "" {
		return nil
	}
	rows := parseDismCapabilities(raw, query)
	if len(rows) > maxCapabilities {
		return rows[:maxCapabilities]
	}
	return rows
}

func capabilitiesPowerShell(query string) []WindowsCapability {
	script := strings.Join([]string{
		"$ProgressPreference='SilentlyContinue'",
		"Get-WindowsCapability -Online -ErrorAction SilentlyContinue | Select-Object -First 500 Name,State | ConvertTo-Json -Compress",
	}, ";")
	raw, err := runHidden(90*time.Second, powershellExe(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	if err != nil && raw == "" {
		return nil
	}
	return parseCapabilityJSON(raw, query)
}

func capabilityStateName(v uint32) string {
	switch v {
	case 0:
		return "not_present"
	case 1:
		return "uninstall_pending"
	case 2:
		return "staged"
	case 3:
		return "resolved"
	case 4:
		return "removed"
	case 5:
		return "installed"
	case 6:
		return "permanent"
	case 7:
		return "superseded"
	case 8:
		return "partially_installed"
	default:
		return "unknown"
	}
}

func mapDismHR(hr uint32) error {
	switch hr {
	case dismAccessDenied, 0x80004005:
		return ErrDismAccessDenied
	case 0x80040154, 0x8007007E:
		return ErrDismUnavailable
	default:
		if hr == 0 {
			return nil
		}
		return ErrDismUnavailable
	}
}

func InstallCapability(req InstallCapabilityRequest) (*InstallCapabilityResult, error) {
	if !AllowedCapabilityInstall(req.Name) {
		return nil, ErrInvalidPayload
	}
	raw, err := runHidden(10*time.Minute, system32("dism.exe"), "/online", "/add-capability", "/capabilityname:"+req.Name, "/norestart")
	lower := strings.ToLower(raw)
	reboot := strings.Contains(lower, "restart") || strings.Contains(lower, "reboot")
	if err != nil && !reboot && !strings.Contains(lower, "successfully") {
		if strings.Contains(lower, "access") {
			return nil, ErrDismAccessDenied
		}
		return nil, ErrDismUnavailable
	}
	out := raw
	if len(out) > 800 {
		out = out[len(out)-800:]
	}
	return &InstallCapabilityResult{Name: req.Name, Started: true, RebootRequired: reboot, Output: strings.TrimSpace(out)}, nil
}

func parseCapabilityJSON(raw, query string) []WindowsCapability {
	query = strings.ToLower(strings.TrimSpace(query))
	raw = strings.TrimSpace(raw)
	if i := strings.IndexAny(raw, "[{"); i > 0 {
		raw = strings.TrimSpace(raw[i:])
	}
	if raw == "" {
		return nil
	}
	if strings.HasPrefix(raw, "{") {
		raw = "[" + raw + "]"
	}
	var rows []map[string]any
	if err := json.Unmarshal([]byte(raw), &rows); err != nil {
		return nil
	}
	out := make([]WindowsCapability, 0, len(rows))
	for _, row := range rows {
		name := jsonString(row, "Name", "name")
		if name == "" {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(name), query) {
			continue
		}
		state := jsonString(row, "State", "state")
		out = append(out, WindowsCapability{
			Name:  name,
			State: dismStateName(state),
			Kind:  capabilityKind(name),
		})
		if len(out) >= maxCapabilities {
			break
		}
	}
	return out
}
