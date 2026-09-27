//go:build windows

package winops

import (
	"errors"
	"fmt"
	"strconv"

	"github.com/pc-manager/agent/internal/svcctl"
	"golang.org/x/sys/windows/registry"
)

func AdminCenter() (*AdminCenterResult, error) {
	out := &AdminCenterResult{Name: WACServiceName}
	info, err := svcctl.Query(WACServiceName)
	if err != nil {
		if errors.Is(err, svcctl.ErrNotFound) {
			fillWACReg(out)
			return out, nil
		}
		if errors.Is(err, svcctl.ErrAccessDenied) || errors.Is(err, svcctl.ErrUnsupported) {
			return nil, ErrWACAccessDenied
		}
		return nil, err
	}
	out.Installed = true
	out.Running = info.Status == "running"
	out.StartType = info.StartType
	out.DisplayName = info.DisplayName
	fillWACReg(out)
	return out, nil
}

func fillWACReg(out *AdminCenterResult) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\ServerManagementGateway`, registry.QUERY_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	if !out.Installed {
		out.Installed = true
	}
	if out.DisplayName == "" {
		if s, _, err := k.GetStringValue(""); err == nil && s != "" {
			out.DisplayName = s
		}
	}
	for _, name := range []string{"Port", "HttpsPort", "SmePort"} {
		if n, _, err := k.GetIntegerValue(name); err == nil && n > 0 && n <= 65535 {
			out.Port = int(n)
			break
		}
		if s, _, err := k.GetStringValue(name); err == nil {
			if p, conv := strconv.Atoi(s); conv == nil && p > 0 && p <= 65535 {
				out.Port = p
				break
			}
		}
	}
	if out.Port > 0 {
		out.URL = fmt.Sprintf("https://localhost:%d", out.Port)
	}
}
