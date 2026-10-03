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
	Manufacturer      string
	SMBIOSBIOSVersion string
	SerialNumber      string
}

type win32Enclosure struct {
	ChassisTypes []uint16
}

type win32Processor struct {
	Name                      string
	NumberOfCores             uint32
	NumberOfLogicalProcessors uint32
	MaxClockSpeed             uint32
}

type win32Memory struct {
	BankLabel    string
	Capacity     uint64
	Speed        uint32
	Manufacturer string
	SerialNumber string
}

type win32Disk struct {
	Model        string
	SerialNumber string
	Size         uint64
	DeviceID     string
}

type win32OS struct {
	Caption        string
	Version        string
	BuildNumber    string
	LastBootUpTime string
	CSName         string
}

type win32Service struct {
	Name        string
	DisplayName string
	State       string
	StartMode   string
	StartName   string
	PathName    string
}

type win32Printer struct {
	Name       string
	DriverName string
	PortName   string
}

func collectPlatform(rep *Report) {
	var systems []win32ComputerSystem
	if err := wmi.Query("SELECT Manufacturer, Model FROM Win32_ComputerSystem", &systems); err == nil && len(systems) > 0 {
		rep.Hardware.Manufacturer = clip(systems[0].Manufacturer, 128)
		rep.Hardware.Model = clip(systems[0].Model, 128)
	}
	var bios []win32BIOS
	if err := wmi.Query("SELECT Manufacturer, SMBIOSBIOSVersion, SerialNumber FROM Win32_BIOS", &bios); err == nil && len(bios) > 0 {
		rep.Hardware.Serial = CleanSerial(bios[0].SerialNumber)
		rep.Hardware.BiosVendor = clip(bios[0].Manufacturer, 128)
		rep.Hardware.BiosVersion = clip(bios[0].SMBIOSBIOSVersion, 128)
	}
	var boxes []win32Enclosure
	if err := wmi.Query("SELECT ChassisTypes FROM Win32_SystemEnclosure", &boxes); err == nil && len(boxes) > 0 && len(boxes[0].ChassisTypes) > 0 {
		rep.Hardware.Chassis = clip(chassisName(boxes[0].ChassisTypes[0]), 32)
	}
	var processors []win32Processor
	if err := wmi.Query("SELECT Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed FROM Win32_Processor", &processors); err == nil && len(processors) > 0 {
		rep.CPUs = nil
		for _, item := range processors {
			if len(rep.CPUs) >= 8 {
				break
			}
			rep.CPUs = append(rep.CPUs, CPU{Name: clip(item.Name, 256), Cores: int(item.NumberOfCores), Threads: int(item.NumberOfLogicalProcessors), Mhz: float64(item.MaxClockSpeed)})
		}
	}
	var modules []win32Memory
	if err := wmi.Query("SELECT BankLabel, Capacity, Speed, Manufacturer, SerialNumber FROM Win32_PhysicalMemory", &modules); err == nil {
		rep.Memory = nil
		for _, item := range modules {
			if len(rep.Memory) >= 32 {
				break
			}
			rep.Memory = append(rep.Memory, Memory{Bank: clip(item.BankLabel, 64), SizeBytes: item.Capacity, SpeedMhz: int(item.Speed), Manufacturer: clip(item.Manufacturer, 128), Serial: CleanSerial(item.SerialNumber)})
		}
	}
	var disks []win32Disk
	if err := wmi.Query("SELECT Model, SerialNumber, Size, DeviceID FROM Win32_DiskDrive", &disks); err == nil && len(disks) > 0 {
		rep.Disks = nil
		for _, item := range disks {
			if len(rep.Disks) >= 32 {
				break
			}
			rep.Disks = append(rep.Disks, Disk{Name: clip(item.DeviceID, 128), Model: clip(item.Model, 256), Serial: CleanSerial(item.SerialNumber), SizeBytes: item.Size})
		}
	}
	var operating []win32OS
	if err := wmi.Query("SELECT Caption, Version, BuildNumber, LastBootUpTime, CSName FROM Win32_OperatingSystem", &operating); err == nil && len(operating) > 0 {
		rep.OS.Name = clip(operating[0].Caption, 256)
		rep.OS.Version = clip(operating[0].Version, 128)
		rep.OS.Build = clip(operating[0].BuildNumber, 128)
		if rep.OS.Hostname == "" {
			rep.OS.Hostname = clip(operating[0].CSName, 256)
		}
	}
	var svc []win32Service
	if err := wmi.Query("SELECT Name, DisplayName, State, StartMode, StartName, PathName FROM Win32_Service", &svc); err == nil && len(svc) > 0 {
		rep.Services = nil
		for _, item := range svc {
			if len(rep.Services) >= 300 {
				break
			}
			rep.Services = append(rep.Services, Service{
				Name: clip(item.Name, 256), DisplayName: clip(item.DisplayName, 256), State: clip(item.State, 32),
				StartType: clip(item.StartMode, 32), Account: clip(item.StartName, 128), BinaryPath: clip(RedactConfig(item.PathName), 1024),
			})
		}
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
	if len(rep.Services) == 0 {
		if listed, err := svcctl.List(); err == nil {
			for _, item := range listed.Services {
				if len(rep.Services) >= 300 {
					break
				}
				rep.Services = append(rep.Services, Service{Name: item.Name, DisplayName: item.DisplayName, State: item.Status, StartType: item.StartType})
			}
		}
	}
	readUninstall(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`, rep)
	readUninstall(registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`, rep)
	readRun(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, rep)
	readRun(registry.CURRENT_USER, `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, rep)
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
		installDate, _, _ := sub.GetStringValue("InstallDate")
		installPath, _, _ := sub.GetStringValue("InstallLocation")
		sub.Close()
		if strings.TrimSpace(display) == "" {
			continue
		}
		rep.Software = append(rep.Software, Software{
			Name: clip(display, 256), Version: clip(version, 128), Publisher: clip(publisher, 256), Source: "registry",
			InstallDate: clip(installDate, 32), InstallPath: clip(installPath, 1024),
		})
	}
}

func chassisName(code uint16) string {
	switch code {
	case 3:
		return "desktop"
	case 8, 9, 10, 14:
		return "laptop"
	case 17, 23:
		return "rack"
	case 1:
		return "other"
	default:
		return ""
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
