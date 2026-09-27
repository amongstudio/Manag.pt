//go:build windows

package commands

import (
	"os/exec"

	"github.com/pc-manager/agent/internal/winsvc"
)

func restartOS() error {
	_ = winsvc.StopHelper()
	return exec.Command("shutdown", "/r", "/t", "5", "/f").Start()
}

func shutdownOS() error {
	_ = winsvc.StopHelper()
	return exec.Command("shutdown", "/s", "/t", "5", "/f").Start()
}
