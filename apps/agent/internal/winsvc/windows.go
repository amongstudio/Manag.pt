//go:build windows

package winsvc

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/pc-manager/agent/internal/config"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func ApplyRecovery(serviceName string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("open %s: %w", serviceName, err)
	}
	defer s.Close()
	actions := []mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
	}
	if err := s.SetRecoveryActions(actions, 86400); err != nil {
		return fmt.Errorf("recovery %s: %w", serviceName, err)
	}
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return fmt.Errorf("recovery flag %s: %w", serviceName, err)
	}
	return nil
}

func serviceExists(name string) bool {
	m, err := mgr.Connect()
	if err != nil {
		return false
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return false
	}
	s.Close()
	return true
}

func AgentInstalled() bool {
	return serviceExists(AgentServiceName)
}

func HelperInstalled() bool {
	return serviceExists(HelperServiceName)
}

func serviceRunning(name string) bool {
	m, err := mgr.Connect()
	if err != nil {
		return false
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return false
	}
	defer s.Close()
	q, err := s.Query()
	if err != nil {
		return false
	}
	return q.State == svc.Running || q.State == svc.StartPending
}

func AgentRunning() bool {
	return serviceRunning(AgentServiceName)
}

func SelfInstall() error {
	src, err := os.Executable()
	if err != nil {
		return err
	}
	src, err = filepath.Abs(src)
	if err != nil {
		return err
	}
	destDir := InstallDir()
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return err
	}
	_ = CoordinatedStop()
	waitServicesStopped(15 * time.Second)

	destAgent := filepath.Join(destDir, AgentExeName())
	if !samePath(src, destAgent) {
		if err := copyFileRetry(src, destAgent); err != nil {
			return fmt.Errorf("copy agent: %w", err)
		}
	}
	if h := FindHelperBinary(src); h != "" {
		destHelper := filepath.Join(destDir, HelperExeName())
		if !samePath(h, destHelper) {
			if err := copyFileRetry(h, destHelper); err != nil {
				return fmt.Errorf("copy helper: %w", err)
			}
		}
	} else if FindHelperBinary(destAgent) == "" {
		log.Println("WARNING: " + HelperMissingWarning)
		Alert("Mnag.pt Agent", HelperMissingWarning)
	}

	sidecar := FindSidecarYAML(src)
	destYAML := filepath.Join(destDir, "config.yaml")
	if sidecar != "" {
		if err := config.MergeSidecarYAML(sidecar, destYAML); err != nil {
			log.Printf("WARNING: copy config.yaml: %v", err)
		}
	} else if p := FindSidecarYAML(destAgent); p != "" {
		destYAML = p
	}
	if err := config.PersistForService(destYAML, sidecar); err != nil {
		log.Printf("WARNING: persist config for service: %v", err)
	}
	_ = migrateUserConfig()

	if err := InstallServices(destAgent); err != nil {
		return err
	}
	return CoordinatedStart()
}

func waitServicesStopped(d time.Duration) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if !serviceRunning(AgentServiceName) && !serviceRunning(HelperServiceName) {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func migrateUserConfig() error {
	return migrateUserConfigImpl()
}
