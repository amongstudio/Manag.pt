//go:build linux

package procutil

import (
	"os"
	"os/exec"
	"syscall"
)

// denyNetwork isolates the child in a fresh network namespace when the agent is
// privileged. The new namespace has only a down loopback, so the child has no
// usable network. Creating one needs CAP_SYS_ADMIN; without privilege we skip
// it and rely on the proxy-env blackhole from DenyNetwork.
func denyNetwork(cmd *exec.Cmd) {
	if os.Geteuid() != 0 {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Cloneflags |= syscall.CLONE_NEWNET
}
