//go:build !windows

package software

import (
	"context"
	"errors"
	"os/exec"
	"time"

	"github.com/pc-manager/agent/internal/procutil"
)

func packageManager(action string, pkg string) (*exec.Cmd, context.CancelFunc, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	if _, err := exec.LookPath("apt-get"); err == nil {
		verb := "install"
		if action == "remove" {
			verb = "remove"
		}
		return exec.CommandContext(ctx, "apt-get", verb, "-y", "--", pkg), cancel, nil
	}
	if _, err := exec.LookPath("dnf"); err == nil {
		return exec.CommandContext(ctx, "dnf", action, "-y", "--", pkg), cancel, nil
	}
	cancel()
	return nil, nil, errors.New("no package manager")
}

func runPM(action, pkg string) (map[string]any, error) {
	cmd, cancel, err := packageManager(action, pkg)
	if err != nil {
		return nil, err
	}
	defer cancel()
	procutil.Harden(cmd, 10*time.Second)
	out, err := cmd.CombinedOutput()
	return map[string]any{"method": "package_manager", "output": capOutput(out)}, err
}

func Install(_ context.Context, req InstallRequest) (map[string]any, error) {
	return runPM("install", req.ID)
}

func Uninstall(_ context.Context, req UninstallRequest) (map[string]any, error) {
	return runPM("remove", req.Name)
}
