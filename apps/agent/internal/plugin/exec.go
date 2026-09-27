package plugin

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/pc-manager/agent/internal/client"
	"github.com/pc-manager/agent/internal/procutil"
)

type artifact struct {
	Path    string
	Cleanup func()
}

func extFor(runtimeName string) string {
	switch runtimeName {
	case "python":
		return ".py"
	case "go_source":
		return ".go"
	case "binary":
		if runtime.GOOS == "windows" {
			return ".exe"
		}
		return ""
	case "js_goja":
		return ".js"
	default:
		return ".bin"
	}
}

func execPlugin(ctx context.Context, meta *client.PluginMeta, blob []byte, args []string, progress func(int)) (any, error) {
	if err := enforcePluginConstraints(meta); err != nil {
		return nil, err
	}
	art, err := stageForExec(meta.Runtime, blob)
	if err != nil {
		return nil, err
	}
	defer art.Cleanup()

	cmd, err := pluginCmd(ctx, meta.Runtime, art.Path, args)
	if err != nil {
		return nil, err
	}
	cmd.Env = pluginEnv()
	if meta.Runtime == "go_source" {
		cache := os.TempDir() + string(os.PathSeparator) + "pc-plugin-gocache"
		cmd.Env = append(cmd.Env, "CGO_ENABLED=0", "GOCACHE="+cache)
	}
	cmd.Dir = os.TempDir()
	procutil.Harden(cmd, 10*time.Second)
	if !meta.NetworkAllowed {
		procutil.DenyNetwork(cmd)
	}
	applyHideWindow(cmd)

	stdout := &scanWriter{cap: stdoutCap, progress: progress}
	stderr := &capBuffer{cap: stdoutCap}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Stdin = nil

	if progress != nil {
		progress(50)
	}
	runErr := cmd.Run()
	out := stdout.Flush()
	errText := stderr.String()
	result := map[string]any{
		"stdout":         out,
		"stderr":         errText,
		"runtime":        meta.Runtime,
		"pluginId":       meta.ID,
		"networkAllowed": meta.NetworkAllowed,
		"timeoutSec":     meta.TimeoutSec,
	}
	if ctx.Err() == context.DeadlineExceeded || errors.Is(runErr, context.DeadlineExceeded) {
		result["error"] = "plugin timeout"
		return result, fmt.Errorf("plugin timeout after %s", time.Duration(meta.TimeoutSec)*time.Second)
	}
	if runErr != nil {
		result["error"] = runErr.Error()
		return result, runErr
	}
	if progress != nil {
		progress(100)
	}
	return result, nil
}

// enforcePluginConstraints rejects a plugin whose declared platform or arch
// does not match the host. Empty (or "any"/"all") means unconstrained.
func enforcePluginConstraints(meta *client.PluginMeta) error {
	if p := strings.ToLower(strings.TrimSpace(meta.Platform)); p != "" && p != "any" && p != "all" && p != runtime.GOOS {
		return fmt.Errorf("plugin platform %q does not match host %s", meta.Platform, runtime.GOOS)
	}
	if a := strings.ToLower(strings.TrimSpace(meta.Arch)); a != "" && a != "any" && a != "all" && a != runtime.GOARCH {
		return fmt.Errorf("plugin arch %q does not match host %s", meta.Arch, runtime.GOARCH)
	}
	return nil
}

func pluginCmd(ctx context.Context, runtimeName, path string, args []string) (*exec.Cmd, error) {
	switch runtimeName {
	case "python":
		return pythonCmd(ctx, path, args)
	case "go_source":
		goBin, err := exec.LookPath("go")
		if err != nil {
			return nil, errors.New("go toolchain not found")
		}
		argv := append([]string{"run", path}, args...)
		return exec.CommandContext(ctx, goBin, argv...), nil
	case "binary":
		return exec.CommandContext(ctx, path, args...), nil
	case "js_goja":
		return nil, errors.New("js_goja runtime is not implemented")
	default:
		return nil, fmt.Errorf("unknown runtime %s", runtimeName)
	}
}

func pythonCmd(ctx context.Context, script string, args []string) (*exec.Cmd, error) {
	extra := append([]string{script}, args...)
	for _, name := range []string{"python3", "python"} {
		if p, err := exec.LookPath(name); err == nil {
			return exec.CommandContext(ctx, p, extra...), nil
		}
	}
	if runtime.GOOS == "windows" {
		if p, err := exec.LookPath("py"); err == nil {
			return exec.CommandContext(ctx, p, append([]string{"-3"}, extra...)...), nil
		}
	}
	return nil, errors.New("python not found")
}

func pluginEnv() []string {
	keys := []string{
		"PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM",
		"USERPROFILE", "USERNAME", "SystemRoot", "WINDIR", "COMSPEC",
		"TEMP", "TMP", "TMPDIR", "SystemDrive", "PATHEXT",
		"PROGRAMFILES", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA",
		"ProgramData", "PUBLIC",
	}
	env := make([]string, 0, len(keys)+2)
	for _, k := range keys {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}

type capBuffer struct {
	buf bytes.Buffer
	cap int
}

func (c *capBuffer) Write(p []byte) (int, error) {
	remain := c.cap - c.buf.Len()
	if remain <= 0 {
		return len(p), nil
	}
	if len(p) > remain {
		_, _ = c.buf.Write(p[:remain])
		return len(p), nil
	}
	return c.buf.Write(p)
}

func (c *capBuffer) String() string { return c.buf.String() }

type scanWriter struct {
	cap      int
	buf      bytes.Buffer
	rest     string
	progress func(int)
}

func (w *scanWriter) Write(p []byte) (int, error) {
	s := w.rest + string(p)
	w.rest = ""
	for {
		i := strings.IndexByte(s, '\n')
		if i < 0 {
			w.rest = s
			break
		}
		line := strings.TrimRight(s[:i], "\r")
		s = s[i+1:]
		w.handleLine(line, true)
	}
	return len(p), nil
}

func (w *scanWriter) handleLine(line string, newline bool) {
	if n, ok := parseProgress(line); ok {
		if w.progress != nil {
			w.progress(n)
		}
		return
	}
	text := line
	if newline {
		text += "\n"
	}
	remain := w.cap - w.buf.Len()
	if remain <= 0 {
		return
	}
	if len(text) > remain {
		text = text[:remain]
	}
	_, _ = w.buf.WriteString(text)
}

func (w *scanWriter) Flush() string {
	if w.rest != "" {
		w.handleLine(strings.TrimRight(w.rest, "\r"), false)
		w.rest = ""
	}
	return w.buf.String()
}

func stageTemp(data []byte, ext string, executable bool) (artifact, error) {
	f, err := os.CreateTemp("", "pc-plugin-*"+ext)
	if err != nil {
		return artifact{}, err
	}
	path := f.Name()
	cleanup := func() { _ = os.Remove(path) }
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		cleanup()
		return artifact{}, err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		cleanup()
		return artifact{}, err
	}
	if err := f.Close(); err != nil {
		cleanup()
		return artifact{}, err
	}
	if executable {
		_ = os.Chmod(path, 0o700)
	}
	return artifact{Path: path, Cleanup: cleanup}, nil
}
