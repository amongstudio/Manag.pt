package winsvc

import (
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/kardianos/service"
	"github.com/pc-manager/agent/internal/config"
)

func InstallServices(agentExe string) error {
	agentExe, err := filepath.Abs(agentExe)
	if err != nil {
		return err
	}
	persistInstallConfig(agentExe)
	helperPath, err := stageHelper(agentExe)
	if err != nil {
		log.Println("WARNING: " + HelperMissingWarning)
	} else if helperPath != "" {
		if err := installHelper(helperPath); err != nil && !alreadyInstalledErr(err) {
			return fmt.Errorf("install helper: %w", err)
		}
		_ = ApplyRecovery(HelperServiceUnit())
	}
	s, err := service.New(nopProgram{}, AgentServiceConfig(agentExe))
	if err != nil {
		return err
	}
	if err := service.Control(s, "install"); err != nil && !alreadyInstalledErr(err) {
		return fmt.Errorf("install agent: %w", err)
	}
	if err := ApplyRecovery(AgentServiceUnit()); err != nil {
		return err
	}
	return nil
}

func persistInstallConfig(agentExe string) {
	destYAML := SidecarYAML(agentExe)
	paths := []string{destYAML}
	if src := FindSidecarYAML(agentExe); src != "" && !samePath(src, destYAML) {
		paths = append(paths, src)
	}
	if err := config.PersistForService(paths...); err != nil {
		log.Printf("WARNING: persist config for service: %v", err)
	}
}

func stageHelper(agentExe string) (string, error) {
	h := FindHelperBinary(agentExe)
	if h == "" {
		return "", fmt.Errorf("helper not found")
	}
	dest := filepath.Join(filepath.Dir(agentExe), HelperExeName())
	if !samePath(h, dest) {
		if err := copyFileRetry(h, dest); err != nil {
			return "", err
		}
	}
	return dest, nil
}

func installHelper(helperExe string) error {
	abs, err := filepath.Abs(helperExe)
	if err != nil {
		return err
	}
	if err := writeHelperYAML(filepath.Dir(abs)); err != nil {
		return err
	}
	s, err := service.New(nopProgram{}, HelperServiceConfig(abs))
	if err != nil {
		return err
	}
	if err := service.Control(s, "install"); err != nil && !alreadyInstalledErr(err) {
		return err
	}
	return nil
}

func writeHelperYAML(dir string) error {
	path := filepath.Join(dir, "helper.yaml")
	if _, err := os.Stat(path); err == nil {
		config.RestrictFileACL(path)
		return nil
	}
	if err := os.WriteFile(path, []byte(DefaultHelperYAML()), 0o644); err != nil {
		return err
	}
	config.RestrictFileACL(path)
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func copyFileRetry(src, dst string) error {
	var last error
	for i := 0; i < 10; i++ {
		last = copyFile(src, dst)
		if last == nil {
			return nil
		}
		if !isBusyFile(last) {
			return last
		}
		time.Sleep(time.Duration(200*(i+1)) * time.Millisecond)
	}
	return fmt.Errorf("copy %s: file in use: %w", dst, last)
}

func isBusyFile(err error) bool {
	if err == nil {
		return false
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch errno {
		case 5, 32, 33: // ACCESS_DENIED, SHARING_VIOLATION, LOCK_VIOLATION
			return true
		}
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "being used by another process") ||
		strings.Contains(msg, "access is denied") ||
		strings.Contains(msg, "sharing violation")
}
