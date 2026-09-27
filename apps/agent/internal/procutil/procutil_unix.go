//go:build !windows

package procutil

import (
	"os/exec"
	"syscall"
)

func setProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

func terminate(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	// A negative pid targets the whole process group created via Setpgid.
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	_ = cmd.Process.Kill()
}
