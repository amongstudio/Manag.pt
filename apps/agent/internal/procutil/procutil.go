// Package procutil hardens child-process execution so a backgrounded
// grandchild cannot hold the agent blocked forever, and provides best-effort
// network isolation for untrusted plugins.
package procutil

import (
	"os/exec"
	"time"
)

// Harden bounds the post-exit I/O wait with WaitDelay and places the child in
// its own process group so the whole tree can be signalled on timeout. It must
// be called after the *exec.Cmd is created (typically via CommandContext) and
// before Start/Run.
func Harden(cmd *exec.Cmd, waitDelay time.Duration) {
	if cmd == nil {
		return
	}
	if waitDelay <= 0 {
		waitDelay = 10 * time.Second
	}
	cmd.WaitDelay = waitDelay
	setProcessGroup(cmd)
	// When created with CommandContext, Cancel defaults to killing only the
	// leader; escalate to the entire process group so grandchildren die too.
	if cmd.Cancel != nil {
		cmd.Cancel = func() error {
			terminate(cmd)
			return nil
		}
	}
}

// DenyNetwork makes a best-effort attempt to cut the child off from the
// network. On Linux with privilege it runs the child in a fresh network
// namespace; everywhere it blackholes proxy environment variables so
// proxy-aware runtimes cannot reach out. cmd.Env must already be populated with
// the intended base environment before calling, otherwise the child would lose
// its inherited environment.
func DenyNetwork(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	denyNetwork(cmd)
	cmd.Env = append(cmd.Env, noNetworkEnv()...)
}

func noNetworkEnv() []string {
	const blackhole = "http://127.0.0.1:1"
	return []string{
		"HTTP_PROXY=" + blackhole,
		"http_proxy=" + blackhole,
		"HTTPS_PROXY=" + blackhole,
		"https_proxy=" + blackhole,
		"ALL_PROXY=" + blackhole,
		"all_proxy=" + blackhole,
		"NO_PROXY=",
		"no_proxy=",
		"PCM_NETWORK_ALLOWED=0",
	}
}
