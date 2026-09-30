//go:build windows

package inventory

import (
	"strings"

	"github.com/pc-manager/agent/internal/svcctl"
	"github.com/yusufpapurcu/wmi"
	"golang.org/x/sys/windows/registry"
)

type win32ComputerSystem struct {
	Manufacturer string
	Model        string
}

type win32BIOS struct {
	SerialNumber string
}

type win32Printer struct {
	Name       string
	DriverName string
	PortName   string
}

type win32UserAccount struct {
	Name         string
	SID          string
	Disabled     bool
	LocalAccount bool
}

func collectPlatform(rep *Report) {
	var systems []win32ComputerSystem
	if err := wmi.Query("SELECT Manufacturer, Model FROM Win32_ComputerSystem", &systems); err == nil && len(systems) > 0 {
		rep.Hardware.Manufacturer = clip(systems[0].Manufacturer, 128)
		rep.Hardware.Model = clip(systems[0].Model, 128)
	}
	var bios []win32BIOS
	if err := wmi.Query("SELECT SerialNumber FROM Win32_BIOS", &bios); err == nil && len(bios) > 0 {
		rep.Hardware.Serial = clip(bios[0].SerialNumber, 128)
	}
	var printers []win32Printer
	if err := wmi.Query("SELECT Name, DriverName, PortName FROM Win32_Printer", &printers); err == nil {
		for _, item := range printers {
			if len(rep.Printers) >= 50 {
				break
			}
			rep.Printers = append(rep.Printers, Printer{Name: clip(item.Name, 256), Driver: clip(item.DriverName, 256), Port: clip(item.PortName, 128)})
		}
	}
	collectWindowsUsers(rep)
	if listed, err := svcctl.List(); err == nil {
		for _, item := range listed.Services {
			if len(rep.Services) >= 300 {
				break
			}
			rep.Services = append(rep.Services, Service{Name: item.Name, DisplayName: item.DisplayName, State: item.Status, StartType: item.StartType})
		}
	}
	readUninstall(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`, rep)
	readUninstall(registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`, rep)
	readRun(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, rep)
	readRun(registry.CURRENT_USER, `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, rep)
}

func collectWindowsUsers(rep *Report) {
	var users []win32UserAccount
	if err := wmi.Query("SELECT Name, SID, Disabled, LocalAccount FROM Win32_UserAccount WHERE LocalAccount=True", &users); err != nil {
		return
	}
	appendWindowsUsers(rep, users)
}

func appendWindowsUsers(rep *Report, rows []win32UserAccount) {
	seen := make(map[string]struct{}, len(rep.Users)+len(rows))
	for _, user := range rep.Users {
		key := strings.ToLower(strings.TrimSpace(user.SID))
		if key == "" {
			key = "name:" + strings.ToLower(strings.TrimSpace(user.Name))
		}
		seen[key] = struct{}{}
	}
	for _, row := range rows {
		if len(rep.Users) >= 200 {
			return
		}
		name := clip(row.Name, 256)
		if name == "" {
			continue
		}
		sid := clip(row.SID, 256)
		key := strings.ToLower(sid)
		if key == "" {
			key = "name:" + strings.ToLower(name)
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		rep.Users = append(rep.Users, User{
			Name:     name,
			SID:      sid,
			Local:    row.LocalAccount,
			Disabled: row.Disabled,
		})
	}
}

func readUninstall(root registry.Key, path string, rep *Report) {
	key, err := registry.OpenKey(root, path, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
	if err != nil {
		return
	}
	defer key.Close()
	names, err := key.ReadSubKeyNames(400)
	if err != nil && len(names) == 0 {
		return
	}
	for _, name := range names {
		if len(rep.Software) >= 400 {
			return
		}
		sub, err := registry.OpenKey(key, name, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		display, _, _ := sub.GetStringValue("DisplayName")
		version, _, _ := sub.GetStringValue("DisplayVersion")
		publisher, _, _ := sub.GetStringValue("Publisher")
		sub.Close()
		if strings.TrimSpace(display) == "" {
			continue
		}
		rep.Software = append(rep.Software, Software{Name: clip(display, 256), Version: clip(version, 128), Publisher: clip(publisher, 256), Source: "registry"})
	}
}

func readRun(root registry.Key, path string, rep *Report) {
	key, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
	if err != nil {
		return
	}
	defer key.Close()
	names, err := key.ReadValueNames(100)
	if err != nil && len(names) == 0 {
		return
	}
	hive := "HKLM"
	if root == registry.CURRENT_USER {
		hive = "HKCU"
	}
	for _, name := range names {
		if len(rep.Startup) >= 100 {
			return
		}
		value, _, err := key.GetStringValue(name)
		if err != nil {
			continue
		}
		rep.Startup = append(rep.Startup, Startup{Name: clip(name, 256), Command: clip(value, 1024), Location: hive + `\` + path})
	}
}
