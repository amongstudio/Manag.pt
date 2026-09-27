//go:build windows

package commands

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

func killPID(pid int) error {
	cmd := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/F")
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("kill pid %d: %s", pid, msg)
	}
	return nil
}
