//go:build windows

package svcctl

import (
	"errors"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func List() (*ListResult, error) {
	m, err := openSCManager(windows.SC_MANAGER_CONNECT | windows.SC_MANAGER_ENUMERATE_SERVICE)
	if err != nil {
		return nil, mapSCMErr(err)
	}
	defer m.Disconnect()

	rows, err := enumServices(m)
	if err != nil {
		return nil, mapSCMErr(err)
	}
	out := make([]Info, 0, len(rows))
	truncated := false
	for i, row := range rows {
		if i >= maxList {
			truncated = true
			break
		}
		info := row
		info.Official = IsOfficial(info.Name)
		if info.Official {
			fillOfficialMeta(m, &info)
		}
		out = append(out, info)
	}
	return &ListResult{Services: out, Truncated: truncated}, nil
}

func Query(name string) (*Info, error) {
	n, err := ValidateName(name)
	if err != nil {
		return nil, err
	}
	m, err := openSCManager(windows.SC_MANAGER_CONNECT)
	if err != nil {
		return nil, mapSCMErr(err)
	}
	defer m.Disconnect()
	name16, err := windows.UTF16PtrFromString(n)
	if err != nil {
		return nil, ErrInvalidName
	}
	h, err := windows.OpenService(m.Handle, name16, windows.SERVICE_QUERY_STATUS|windows.SERVICE_QUERY_CONFIG)
	if err != nil {
		return nil, mapServiceErr(err)
	}
	s := &mgr.Service{Name: n, Handle: h}
	defer s.Close()
	info := Info{Name: n, Official: IsOfficial(n)}
	if st, err := s.Query(); err == nil {
		info.Status = stateName(st.State)
		info.PID = st.ProcessId
	}
	display, startType, err := serviceMeta(s)
	if err == nil {
		info.DisplayName = display
		info.StartType = startTypeName(startType)
	}
	if info.Status == "" {
		info.Status = "unknown"
	}
	return &info, nil
}

func openSCManager(access uint32) (*mgr.Mgr, error) {
	h, err := windows.OpenSCManager(nil, nil, access)
	if err != nil {
		return nil, err
	}
	return &mgr.Mgr{Handle: h}, nil
}

func fillOfficialMeta(m *mgr.Mgr, info *Info) {
	if info == nil || info.Name == "" {
		return
	}
	name16, err := windows.UTF16PtrFromString(info.Name)
	if err != nil {
		return
	}
	h, err := windows.OpenService(m.Handle, name16, windows.SERVICE_QUERY_CONFIG)
	if err != nil {
		return
	}
	s := &mgr.Service{Name: info.Name, Handle: h}
	defer s.Close()
	display, startType, err := serviceMeta(s)
	if err != nil {
		return
	}
	if info.DisplayName == "" {
		info.DisplayName = display
	}
	info.StartType = startTypeName(startType)
}

func Start(name string) (*ControlResult, error) {
	return control(name, "start")
}

func Stop(name string) (*ControlResult, error) {
	return control(name, "stop")
}

func Restart(name string) (*ControlResult, error) {
	return control(name, "restart")
}

func control(name, action string) (*ControlResult, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, err
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return nil, mapServiceErr(err)
	}
	defer s.Close()

	switch action {
	case "start":
		if err := startService(s); err != nil {
			return nil, err
		}
	case "stop":
		if err := stopService(s); err != nil {
			return nil, err
		}
	case "restart":
		if err := stopService(s); err != nil {
			return nil, err
		}
		if err := startService(s); err != nil {
			return nil, err
		}
	}
	return snapshot(s, name, action)
}

func startService(s *mgr.Service) error {
	st, err := s.Query()
	if err == nil && st.State == svc.Running {
		return nil
	}
	err = s.Start()
	if err == nil || errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return waitState(s, svc.Running, 30*time.Second)
	}
	return err
}

func stopService(s *mgr.Service) error {
	st, err := s.Query()
	if err != nil {
		return err
	}
	if st.State == svc.Stopped {
		return nil
	}
	_, err = s.Control(svc.Stop)
	if err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
		return err
	}
	return waitState(s, svc.Stopped, 45*time.Second)
}

func waitState(s *mgr.Service, want svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		st, err := s.Query()
		if err != nil {
			return err
		}
		if st.State == want {
			return nil
		}
		if time.Now().After(deadline) {
			return ErrTimeout
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func snapshot(s *mgr.Service, name, action string) (*ControlResult, error) {
	res := &ControlResult{Name: name, Action: action}
	if st, err := s.Query(); err == nil {
		res.Status = stateName(st.State)
		res.PID = st.ProcessId
	}
	if _, startType, err := serviceMeta(s); err == nil {
		res.StartType = startTypeName(startType)
	}
	return res, nil
}

func enumServices(m *mgr.Mgr) ([]Info, error) {
	buf := make([]byte, 64*1024)
	var resume uint32
	var out []Info
	for n := 0; n < 64; n++ {
		var bytesNeeded, servicesReturned uint32
		startResume := resume
		err := windows.EnumServicesStatusEx(
			m.Handle,
			windows.SC_ENUM_PROCESS_INFO,
			windows.SERVICE_WIN32,
			windows.SERVICE_STATE_ALL,
			&buf[0],
			uint32(len(buf)),
			&bytesNeeded,
			&servicesReturned,
			&resume,
			nil,
		)
		if err != nil && !isMoreData(err) {
			return nil, err
		}
		if servicesReturned > 0 {
			out = append(out, parseEnumServices(buf, servicesReturned)...)
		}
		if err == nil {
			return out, nil
		}
		if servicesReturned == 0 {
			need := bytesNeeded
			if need <= uint32(len(buf)) {
				need = uint32(len(buf)) * 2
			}
			if need < uint32(len(buf))+1024 {
				return nil, err
			}
			buf = make([]byte, need)
			resume = startResume
			continue
		}
		if bytesNeeded > uint32(len(buf)) {
			buf = make([]byte, bytesNeeded)
		}
	}
	if len(out) > 0 {
		return out, nil
	}
	return nil, ErrEnumFailed
}

func parseEnumServices(buf []byte, n uint32) []Info {
	if n == 0 || len(buf) == 0 {
		return nil
	}
	services := unsafe.Slice((*windows.ENUM_SERVICE_STATUS_PROCESS)(unsafe.Pointer(&buf[0])), int(n))
	out := make([]Info, 0, len(services))
	for _, s := range services {
		out = append(out, Info{
			Name:        windows.UTF16PtrToString(s.ServiceName),
			DisplayName: windows.UTF16PtrToString(s.DisplayName),
			Status:      stateName(svc.State(s.ServiceStatusProcess.CurrentState)),
			PID:         s.ServiceStatusProcess.ProcessId,
		})
	}
	return out
}

func isMoreData(err error) bool {
	return errors.Is(err, windows.ERROR_MORE_DATA) || errors.Is(err, syscall.ERROR_MORE_DATA)
}

func serviceMeta(s *mgr.Service) (string, uint32, error) {
	var p *windows.QUERY_SERVICE_CONFIG
	n := uint32(1024)
	for {
		b := make([]byte, n)
		p = (*windows.QUERY_SERVICE_CONFIG)(unsafe.Pointer(&b[0]))
		err := windows.QueryServiceConfig(s.Handle, p, n, &n)
		if err == nil {
			return windows.UTF16PtrToString(p.DisplayName), p.StartType, nil
		}
		if err != syscall.ERROR_INSUFFICIENT_BUFFER {
			return "", 0, err
		}
		if n <= uint32(len(b)) {
			return "", 0, err
		}
	}
}

func stateName(st svc.State) string {
	switch st {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "start_pending"
	case svc.StopPending:
		return "stop_pending"
	case svc.Running:
		return "running"
	case svc.ContinuePending:
		return "continue_pending"
	case svc.PausePending:
		return "pause_pending"
	case svc.Paused:
		return "paused"
	default:
		return "unknown"
	}
}

func startTypeName(v uint32) string {
	switch v {
	case windows.SERVICE_BOOT_START:
		return "boot"
	case windows.SERVICE_SYSTEM_START:
		return "system"
	case mgr.StartAutomatic:
		return "automatic"
	case mgr.StartManual:
		return "manual"
	case mgr.StartDisabled:
		return "disabled"
	default:
		return "unknown"
	}
}

func mapServiceErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return ErrNotFound
	}
	if isAccessDenied(err) {
		return ErrAccessDenied
	}
	return err
}

func mapSCMErr(err error) error {
	if err == nil {
		return nil
	}
	if isAccessDenied(err) {
		return ErrAccessDenied
	}
	return ErrEnumFailed
}

func isAccessDenied(err error) bool {
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "access is denied") || strings.Contains(msg, "access_denied")
}
