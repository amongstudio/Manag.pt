//go:build !windows

package commands

import (
	"os"
	"syscall"
)

func killPID(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err := proc.Signal(syscall.Signal(0)); err != nil {
		return err
	}
	return proc.Kill()
}
