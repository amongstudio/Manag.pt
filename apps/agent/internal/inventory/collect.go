package inventory

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
)

type Report struct {
	Hardware     Hardware      `json:"hardware"`
	OS           OS            `json:"os"`
	CPUs         []CPU         `json:"cpus"`
	Memory       []Memory      `json:"memory"`
	Disks        []Disk        `json:"disks"`
	Volumes      []Volume      `json:"volumes"`
	GPUs         []GPU         `json:"gpus"`
	Adapters     []Adapter     `json:"adapters"`
	Monitors     []Monitor     `json:"monitors"`
	Printers     []Printer     `json:"printers"`
	USB          []USB         `json:"usb"`
	Software     []Software    `json:"software"`
	Drivers      []Driver      `json:"drivers"`
	Certificates []Certificate `json:"certificates"`
	Services     []Service     `json:"services"`
	Processes    []Proc        `json:"processes"`
	Startup      []Startup     `json:"startup"`
	Browsers     []Browser     `json:"browsers"`
	Users        []User        `json:"users"`
	Updates      []Update      `json:"updates"`
}

type Hardware struct {
	Manufacturer string `json:"manufacturer"`
	Model        string `json:"model"`
	Serial       string `json:"serial"`
	Chassis      string `json:"chassis"`
	BiosVendor   string `json:"biosVendor"`
	BiosVersion  string `json:"biosVersion"`
}

type OS struct {
	Name          string `json:"name"`
	Version       string `json:"version"`
	Build         string `json:"build"`
	Arch          string `json:"arch"`
	Hostname      string `json:"hostname"`
	FQDN          string `json:"fqdn"`
	Kernel        string `json:"kernel"`
	BootTime      string `json:"bootTime"`
	Timezone      string `json:"timezone"`
	Domain        string `json:"domain"`
	Gateway       string `json:"gateway"`
	DNSServers    string `json:"dnsServers"`
	AgentVersion  string `json:"agentVersion"`
	HelperVersion string `json:"helperVersion"`
	Roles         string `json:"roles"`
	PrimaryIPs    string `json:"primaryIps"`
	UptimeSec     uint64 `json:"uptimeSec"`
}

type CPU struct {
	Name    string  `json:"name"`
	Cores   int     `json:"cores"`
	Threads int     `json:"threads"`
	Mhz     float64 `json:"mhz"`
}

type Memory struct {
	Bank         string `json:"bank"`
	SizeBytes    uint64 `json:"sizeBytes"`
	SpeedMhz     int    `json:"speedMhz"`
	Manufacturer string `json:"manufacturer"`
	Serial       string `json:"serial"`
}

type Disk struct {
	Name      string `json:"name"`
	Model     string `json:"model"`
	Serial    string `json:"serial"`
	SizeBytes uint64 `json:"sizeBytes"`
}

type Volume struct {
	Mount     string `json:"mount"`
	FS        string `json:"fs"`
	SizeBytes uint64 `json:"sizeBytes"`
	FreeBytes uint64 `json:"freeBytes"`
}

type GPU struct {
	Name        string `json:"name"`
	Driver      string `json:"driver"`
	MemoryBytes uint64 `json:"memoryBytes"`
}

type Adapter struct {
	Name string   `json:"name"`
	MAC  string   `json:"mac"`
	IPs  []string `json:"ips"`
}

type Monitor struct {
	Name    string `json:"name"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Primary bool   `json:"primary"`
}

type Printer struct {
	Name   string `json:"name"`
	Driver string `json:"driver"`
	Port   string `json:"port"`
}

type USB struct {
	Name      string `json:"name"`
	VendorID  string `json:"vendorId"`
	ProductID string `json:"productId"`
}

type Software struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Publisher   string `json:"publisher"`
	Source      string `json:"source"`
	InstallDate string `json:"installDate"`
	InstallPath string `json:"installPath"`
}

type Driver struct {
	Name     string `json:"name"`
	Version  string `json:"version"`
	Provider string `json:"provider"`
}

type Certificate struct {
	Subject    string `json:"subject"`
	Issuer     string `json:"issuer"`
	Thumbprint string `json:"thumbprint"`
	Store      string `json:"store"`
	NotAfter   string `json:"notAfter"`
}

type Service struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	State       string `json:"state"`
	StartType   string `json:"startType"`
	Account     string `json:"account"`
	BinaryPath  string `json:"binaryPath"`
	ListenPorts string `json:"listenPorts"`
	ConfigNote  string `json:"configNote"`
}

type Proc struct {
	PID      int32   `json:"pid"`
	Name     string  `json:"name"`
	User     string  `json:"user"`
	CPU      float64 `json:"cpu"`
	RAM      float32 `json:"ram"`
	RSSBytes uint64  `json:"rssBytes"`
}

// AgentVersion is set by the agent process. Empty when collect runs outside the agent.
var AgentVersion string

type Startup struct {
	Name     string `json:"name"`
	Command  string `json:"command"`
	Location string `json:"location"`
}

type Browser struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Path    string `json:"path"`
}

type User struct {
	Name     string `json:"name"`
	SID      string `json:"sid"`
	Local    bool   `json:"local"`
	Disabled bool   `json:"disabled"`
}

type Update struct {
	KB        string `json:"kb"`
	Title     string `json:"title"`
	Severity  string `json:"severity"`
	SizeBytes int    `json:"sizeBytes"`
}

func Collect() Report {
	rep := Report{
		CPUs: []CPU{}, Memory: []Memory{}, Disks: []Disk{}, Volumes: []Volume{}, GPUs: []GPU{},
		Adapters: []Adapter{}, Monitors: []Monitor{}, Printers: []Printer{}, USB: []USB{},
		Software: []Software{}, Drivers: []Driver{}, Certificates: []Certificate{}, Services: []Service{},
		Processes: []Proc{}, Startup: []Startup{}, Browsers: []Browser{}, Users: []User{}, Updates: []Update{},
	}
	if info, err := host.Info(); err == nil {
		boot := ""
		if info.BootTime > 0 {
			boot = time.Unix(int64(info.BootTime), 0).UTC().Format(time.RFC3339)
		}
		hostName, _ := os.Hostname()
		rep.OS = OS{
			Name: info.Platform, Version: info.PlatformVersion, Build: info.KernelVersion, Arch: runtime.GOARCH,
			Hostname: hostName, Kernel: info.KernelVersion, BootTime: boot, Timezone: time.Now().Location().String(),
			AgentVersion: AgentVersion, UptimeSec: info.Uptime,
		}
	}
	if infos, err := cpu.Info(); err == nil && len(infos) > 0 {
		cores, _ := cpu.Counts(false)
		threads, _ := cpu.Counts(true)
		if cores == 0 {
			cores = int(infos[0].Cores)
		}
		if threads == 0 {
			threads = len(infos)
		}
		rep.CPUs = append(rep.CPUs, CPU{Name: infos[0].ModelName, Cores: cores, Threads: threads, Mhz: infos[0].Mhz})
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		rep.Memory = append(rep.Memory, Memory{Bank: "total", SizeBytes: vm.Total})
	}
	if parts, err := disk.Partitions(true); err == nil {
		seen := map[string]struct{}{}
		for _, part := range parts {
			if len(rep.Volumes) >= 32 || part.Mountpoint == "" {
				continue
			}
			key := part.Device + part.Mountpoint
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			vol := Volume{Mount: part.Mountpoint, FS: part.Fstype}
			if usage, err := disk.Usage(part.Mountpoint); err == nil {
				vol.SizeBytes = usage.Total
				vol.FreeBytes = usage.Free
				rep.Disks = append(rep.Disks, Disk{Name: part.Device, SizeBytes: usage.Total})
			}
			rep.Volumes = append(rep.Volumes, vol)
		}
	}
	if ifaces, err := net.Interfaces(); err == nil {
		for _, iface := range ifaces {
			if len(rep.Adapters) >= 32 {
				break
			}
			ips := make([]string, 0, len(iface.Addrs))
			for _, addr := range iface.Addrs {
				ips = append(ips, addr.Addr)
			}
			rep.Adapters = append(rep.Adapters, Adapter{Name: iface.Name, MAC: iface.HardwareAddr, IPs: ips})
		}
	}
	if procs, err := process.Processes(); err == nil {
		for _, proc := range procs {
			if len(rep.Processes) >= 120 {
				break
			}
			name, _ := proc.Name()
			user, _ := proc.Username()
			cpuPct, _ := proc.CPUPercent()
			memPct, _ := proc.MemoryPercent()
			var rss uint64
			if memInfo, err := proc.MemoryInfo(); err == nil && memInfo != nil {
				rss = memInfo.RSS
			}
			rep.Processes = append(rep.Processes, Proc{PID: proc.Pid, Name: name, User: user, CPU: cpuPct, RAM: memPct, RSSBytes: rss})
		}
	}
	collectPlatform(&rep)
	return rep
}

func runText(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.Output()
	return string(out), err
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func clip(s string, n int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\x00", ""))
	if len(s) > n {
		return s[:n]
	}
	return s
}
