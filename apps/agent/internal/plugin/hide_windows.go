//go:build windows

package plugin

import (
	"os/exec"
	"syscall"
)

const createNoWindow = 0x08000000

func applyHideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}
