//go:build !linux

package procutil

import "os/exec"

func denyNetwork(_ *exec.Cmd) {}
