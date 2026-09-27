//go:build windows

package procutil

import (
	"os/exec"
	"strconv"
	"syscall"
)

const createNoWindow = 0x08000000

func setProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= syscall.CREATE_NEW_PROCESS_GROUP | createNoWindow
}

func terminate(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	// taskkill /T tears down the whole process tree, including grandchildren
	// that inherited our stdout/stderr handles.
	tk := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	tk.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	_ = tk.Run()
	_ = cmd.Process.Kill()
}
