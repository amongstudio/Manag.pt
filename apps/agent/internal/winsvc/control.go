package winsvc

import (
	"fmt"

	"github.com/kardianos/service"
)

func controlNamed(name, action, exe string) error {
	cfg := &service.Config{Name: name, Executable: exe}
	s, err := service.New(nopProgram{}, cfg)
	if err != nil {
		return err
	}
	return service.Control(s, action)
}

func StopHelper() error {
	return ignoreMissing(controlNamed(HelperServiceUnit(), "stop", InstalledHelperPath()))
}

func CoordinatedStop() error {
	_ = StopHelper()
	if err := ignoreMissing(controlNamed(AgentServiceUnit(), "stop", InstalledAgentPath())); err != nil {
		return fmt.Errorf("stop agent: %w", err)
	}
	return nil
}

func CoordinatedStart() error {
	_ = ignoreMissing(controlNamed(HelperServiceUnit(), "start", InstalledHelperPath()))
	if err := controlNamed(AgentServiceUnit(), "start", InstalledAgentPath()); err != nil {
		return fmt.Errorf("start agent: %w", err)
	}
	return nil
}

func StopAgent() error {
	return ignoreMissing(controlNamed(AgentServiceUnit(), "stop", InstalledAgentPath()))
}

func StartHelper() error {
	return ignoreMissing(controlNamed(HelperServiceUnit(), "start", InstalledHelperPath()))
}

func CoordinatedRestart() error {
	if err := CoordinatedStop(); err != nil {
		return err
	}
	return CoordinatedStart()
}

func CoordinatedUninstall() error {
	_ = StopHelper()
	_ = ignoreMissing(controlNamed(HelperServiceUnit(), "uninstall", InstalledHelperPath()))
	_ = ignoreMissing(controlNamed(AgentServiceUnit(), "stop", InstalledAgentPath()))
	if err := ignoreMissing(controlNamed(AgentServiceUnit(), "uninstall", InstalledAgentPath())); err != nil {
		return fmt.Errorf("uninstall agent: %w", err)
	}
	return nil
}

func InstallFromCLI(agentExe string) error {
	return InstallServices(agentExe)
}

func HandleControl(action, agentExe string) error {
	switch action {
	case "install":
		return InstallFromCLI(agentExe)
	case "uninstall":
		return CoordinatedUninstall()
	case "stop":
		return CoordinatedStop()
	case "start":
		return CoordinatedStart()
	case "restart":
		return CoordinatedRestart()
	default:
		return fmt.Errorf("unknown service action %s", action)
	}
}
