package winsvc

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/kardianos/service"
)

const (
	AgentServiceName  = "PCManagerAgent"
	HelperServiceName = "PCManagerHelper"
	InstallFolderName = "PC Manager Agent"
	AgentDisplayName  = "Mnag.pt Agent"
	HelperDisplayName = "Mnag.pt Helper"
	AgentDescription  = "Mnag.pt fleet agent for heartbeat, commands, and self-update"
	HelperDescription = "Watchdog that keeps the Mnag.pt Agent service running"
)

func AgentExeName() string {
	if runtime.GOOS == "windows" {
		return "pc-manager-agent.exe"
	}
	return "pc-manager-agent"
}

func HelperExeName() string {
	if runtime.GOOS == "windows" {
		return "pc-manager-helper.exe"
	}
	return "pc-manager-helper"
}

func HelperServiceUnit() string {
	if runtime.GOOS == "windows" {
		return HelperServiceName
	}
	return "pc-manager-helper"
}

func AgentServiceUnit() string {
	if runtime.GOOS == "windows" {
		return AgentServiceName
	}
	return "pc-manager-agent"
}

func InstallDir() string {
	if runtime.GOOS == "windows" {
		pf := os.Getenv("ProgramFiles")
		if pf == "" {
			pf = `C:\Program Files`
		}
		return filepath.Join(pf, InstallFolderName)
	}
	return "/opt/pc-manager-agent"
}

func InstalledAgentPath() string {
	return filepath.Join(InstallDir(), AgentExeName())
}

func InstalledHelperPath() string {
	return filepath.Join(InstallDir(), HelperExeName())
}

func samePath(a, b string) bool {
	aa, err := filepath.Abs(a)
	if err != nil {
		aa = a
	}
	bb, err := filepath.Abs(b)
	if err != nil {
		bb = b
	}
	return strings.EqualFold(filepath.Clean(aa), filepath.Clean(bb))
}

func HelperCandidates(agentExe string) []string {
	dir := filepath.Dir(agentExe)
	arch := runtime.GOARCH
	names := []string{
		HelperExeName(),
		"pc-manager-helper-windows-" + arch + ".exe",
		"pc-manager-helper-windows-amd64.exe",
		"pc-manager-helper-windows-arm64.exe",
		"pc-manager-helper-linux-" + arch,
		"pc-manager-helper-linux-amd64",
		"pc-manager-helper-linux-arm64",
	}
	var out []string
	seen := map[string]struct{}{}
	add := func(p string) {
		p = filepath.Clean(p)
		if _, ok := seen[p]; ok {
			return
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	for _, n := range names {
		add(filepath.Join(dir, n))
		add(filepath.Join(dir, "dist", n))
	}
	return out
}

func FindHelperBinary(agentExe string) string {
	for _, p := range HelperCandidates(agentExe) {
		st, err := os.Stat(p)
		if err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

const HelperMissingWarning = "pc-manager-helper.exe was not found next to the agent; installing the agent only (no watchdog). Place pc-manager-helper.exe beside the agent and re-run install to add it."

func SidecarYAML(agentExe string) string {
	return filepath.Join(filepath.Dir(agentExe), "config.yaml")
}

func FindSidecarYAML(agentExe string) string {
	p := SidecarYAML(agentExe)
	st, err := os.Stat(p)
	if err == nil && !st.IsDir() {
		return p
	}
	return ""
}

func DefaultHelperYAML() string {
	name := AgentServiceUnit()
	return "agent_service_name: " + name + "\nstatus_port: 17890\nbackoff_sec: 30\n"
}

type nopProgram struct{}

func (nopProgram) Start(s service.Service) error { return nil }
func (nopProgram) Stop(s service.Service) error  { return nil }

func failureOptions() service.KeyValue {
	return service.KeyValue{
		"OnFailure":              "restart",
		"OnFailureDelayDuration": "5s",
		"OnFailureResetPeriod":   86400,
	}
}

func AgentServiceConfig(exe string) *service.Config {
	return &service.Config{
		Name:        AgentServiceUnit(),
		DisplayName: AgentDisplayName,
		Description: AgentDescription,
		UserName:    "", // Windows: empty → LocalSystem
		Executable:  exe,
		Option:      failureOptions(),
	}
}

func HelperServiceConfig(exe string) *service.Config {
	return &service.Config{
		Name:        HelperServiceUnit(),
		DisplayName: HelperDisplayName,
		Description: HelperDescription,
		UserName:    "", // Windows: empty → LocalSystem
		Executable:  exe,
		Option:      failureOptions(),
	}
}

func alreadyInstalledErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "already exists") || strings.Contains(msg, "already installed")
}

func ignoreMissing(err error) error {
	if err == nil {
		return nil
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "not installed") || strings.Contains(msg, "does not exist") || strings.Contains(msg, "not found") {
		return nil
	}
	return err
}
