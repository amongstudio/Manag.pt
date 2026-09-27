package shell

import (
	"context"
	"encoding/json"
	"io"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/pc-manager/agent/internal/procutil"
	"github.com/pc-manager/agent/internal/wsprotocol"
)

type ExecRequest struct {
	ID      string `json:"id"`
	Command string `json:"command"`
	Shell   string `json:"shell"`
}

func ParseExec(raw json.RawMessage) ExecRequest {
	var req ExecRequest
	_ = json.Unmarshal(raw, &req)
	req.ID = strings.TrimSpace(req.ID)
	req.Command = strings.TrimSpace(req.Command)
	switch req.Shell {
	case KindCmd, KindPowerShell, KindSh:
	default:
		req.Shell = ""
	}
	return req
}

func execCmd(ctx context.Context, kind, command string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		if kind == KindCmd {
			return exec.CommandContext(ctx, "cmd", "/c", command)
		}
		return exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", command)
	}
	return exec.CommandContext(ctx, "sh", "-c", command)
}

func (m *Manager) exec(req ExecRequest) {
	if req.ID == "" {
		return
	}
	if req.Command == "" {
		m.emitExec(req.ID, "", true, 1, "empty command")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), ExecTimeout*time.Second)
	m.mu.Lock()
	if m.execCancel != nil {
		m.execCancel()
	}
	m.execGen++
	gen := m.execGen
	m.execCancel = cancel
	m.mu.Unlock()
	defer func() {
		cancel()
		m.mu.Lock()
		if m.execGen == gen {
			m.execCancel = nil
		}
		m.mu.Unlock()
	}()

	cmd := execCmd(ctx, req.Shell, req.Command)
	procutil.Harden(cmd, 10*time.Second)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		m.emitExec(req.ID, "", true, 1, err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		m.emitExec(req.ID, "", true, 1, err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		m.emitExec(req.ID, "", true, 1, err.Error())
		return
	}

	var (
		mu        sync.Mutex
		written   int
		truncated bool
	)
	pump := func(r io.Reader) {
		buf := make([]byte, 4096)
		for {
			n, readErr := r.Read(buf)
			if n > 0 {
				mu.Lock()
				remain := ExecOutputMax - written
				chunk := buf[:n]
				if remain <= 0 {
					truncated = true
					mu.Unlock()
					continue
				}
				if n > remain {
					chunk = buf[:remain]
					truncated = true
				}
				written += len(chunk)
				mu.Unlock()
				m.emitExec(req.ID, string(chunk), false, 0, "")
			}
			if readErr != nil {
				return
			}
		}
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		pump(stdout)
	}()
	go func() {
		defer wg.Done()
		pump(stderr)
	}()
	wg.Wait()
	waitErr := cmd.Wait()
	mu.Lock()
	wasTruncated := truncated
	mu.Unlock()
	if wasTruncated {
		m.emitExec(req.ID, "\n[output truncated]\n", false, 0, "")
	}
	code := 0
	errText := ""
	if waitErr != nil {
		if ee, ok := waitErr.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			code = 1
			errText = waitErr.Error()
		}
	}
	m.emitExec(req.ID, "", true, code, errText)
}

func (m *Manager) emitExec(id, data string, done bool, exitCode int, errText string) {
	if m == nil || m.send == nil {
		return
	}
	frame := wsprotocol.ShellExec{
		Type: wsprotocol.TypeShellExec,
		ID:   id,
		Data: data,
		Done: done,
	}
	if done {
		frame.ExitCode = &exitCode
		frame.Error = errText
	}
	m.send(frame)
}
