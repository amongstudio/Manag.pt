//go:build !windows

package commands

import (
	"bytes"
	"fmt"
	"os/exec"
)

func tryRun(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s", name, err, bytes.TrimSpace(out))
	}
	return nil
}

func restartOS() error {
	if err := tryRun("systemctl", "reboot"); err == nil {
		return nil
	}
	return tryRun("shutdown", "-r", "now")
}

func shutdownOS() error {
	if err := tryRun("systemctl", "poweroff"); err == nil {
		return nil
	}
	return tryRun("shutdown", "-h", "now")
}
