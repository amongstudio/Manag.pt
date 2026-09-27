//go:build !windows

package plugin

import "os/exec"

func applyHideWindow(cmd *exec.Cmd) {}
