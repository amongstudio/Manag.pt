//go:build linux

package agentctl

import (
	"fmt"
	"os/exec"
	"strings"
	"time"
)

type linuxCtl struct {
	name string
}

func newController(serviceName string) Controller {
	return &linuxCtl{name: serviceName}
}

func systemctl(args ...string) (string, error) {
	cmd := exec.Command("systemctl", args...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (c *linuxCtl) Status() (Status, error) {
	out, err := systemctl("is-active", c.name)
	switch out {
	case "active":
		return StatusRunning, nil
	case "inactive", "failed":
		return StatusStopped, nil
	case "activating":
		return StatusStartPending, nil
	case "not-found":
		return StatusUnknown, fmt.Errorf("systemd unit %s is missing", c.name)
	default:
		if err != nil {
			if strings.Contains(out, "not-found") || strings.Contains(out, "could not be found") {
				return StatusUnknown, fmt.Errorf("systemd unit %s is missing", c.name)
			}
			return StatusUnknown, fmt.Errorf("systemctl is-active %s: %s (%w)", c.name, out, err)
		}
		return StatusUnknown, nil
	}
}

func (c *linuxCtl) Start() error {
	st, err := c.Status()
	if err == nil && st == StatusRunning {
		return nil
	}
	if _, err := systemctl("start", c.name); err != nil {
		return fmt.Errorf("systemctl start %s: %w", c.name, err)
	}
	return waitUntil(30*time.Second, func() bool {
		st, err := c.Status()
		return err == nil && st == StatusRunning
	})
}

func (c *linuxCtl) Stop() error {
	st, err := c.Status()
	if err == nil && st == StatusStopped {
		return nil
	}
	if _, err := systemctl("stop", c.name); err != nil {
		return fmt.Errorf("systemctl stop %s: %w", c.name, err)
	}
	return waitUntil(30*time.Second, func() bool {
		st, err := c.Status()
		return err == nil && st == StatusStopped
	})
}

func (c *linuxCtl) Restart() error {
	if _, err := systemctl("restart", c.name); err != nil {
		return fmt.Errorf("systemctl restart %s: %w", c.name, err)
	}
	time.Sleep(time.Second)
	return nil
}
