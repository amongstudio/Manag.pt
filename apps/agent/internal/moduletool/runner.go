package moduletool

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/pc-manager/agent/internal/client"
	"github.com/pc-manager/agent/internal/procutil"
)

var ErrCancelled = errors.New("module run cancelled")

type Request struct {
	CommandID         string
	ModuleID          string
	ExpectedSignature string
	Args              []string
	Client            *client.Client
	DataDir           string
	Progress          func(int)
}

var cancellations = struct {
	sync.Mutex
	running map[string]context.CancelFunc
	pending map[string]time.Time
}{
	running: make(map[string]context.CancelFunc),
	pending: make(map[string]time.Time),
}

func Cancel(commandID string) {
	if commandID == "" {
		return
	}
	cancellations.Lock()
	defer cancellations.Unlock()
	if cancel := cancellations.running[commandID]; cancel != nil {
		cancel()
		return
	}
	cancellations.pending[commandID] = time.Now()
}

func commandContext(commandID string) (context.Context, context.CancelFunc, bool) {
	ctx, cancel := context.WithCancel(context.Background())
	if commandID == "" {
		return ctx, cancel, false
	}
	cancellations.Lock()
	defer cancellations.Unlock()
	cutoff := time.Now().Add(-30 * time.Minute)
	for id, at := range cancellations.pending {
		if at.Before(cutoff) {
			delete(cancellations.pending, id)
		}
	}
	if _, exists := cancellations.pending[commandID]; exists {
		delete(cancellations.pending, commandID)
		cancel()
		return ctx, cancel, true
	}
	cancellations.running[commandID] = cancel
	return ctx, cancel, false
}

func finishCommand(commandID string, cancel context.CancelFunc) {
	cancel()
	if commandID == "" {
		return
	}
	cancellations.Lock()
	delete(cancellations.running, commandID)
	cancellations.Unlock()
}

func Run(req Request) (any, error) {
	if req.Client == nil {
		return nil, errors.New("module client required")
	}
	ctx, cancel, cancelled := commandContext(req.CommandID)
	defer finishCommand(req.CommandID, cancel)
	if cancelled {
		return map[string]any{"moduleId": req.ModuleID, "error": "cancelled"}, ErrCancelled
	}
	if req.Progress != nil {
		req.Progress(5)
	}
	meta, err := req.Client.FetchModuleMeta(req.ModuleID)
	if err != nil {
		return nil, err
	}
	if err := verifyManifest(meta, req.ExpectedSignature); err != nil {
		return nil, err
	}
	if err := validateArgs(meta.ArgumentsSchema, req.Args); err != nil {
		return nil, err
	}
	if err := executableKind(meta.Kind); err != nil {
		return map[string]any{"moduleId": meta.ID, "kind": meta.Kind}, err
	}
	if req.Progress != nil {
		req.Progress(15)
	}
	artifact, err := cachedArtifact(req.DataDir, meta, req.Client)
	if err != nil {
		return map[string]any{"moduleId": meta.ID, "error": "artifact_unavailable"}, errors.New("module artifact unavailable")
	}
	if req.Progress != nil {
		req.Progress(40)
	}
	runCtx, timeoutCancel := context.WithTimeout(ctx, time.Duration(meta.TimeoutSec)*time.Second)
	defer timeoutCancel()
	return runExecutable(runCtx, artifact, meta, req.Args, req.Progress)
}

func executableKind(kind string) error {
	if kind == "dll-plugin" {
		return errors.New("dll-plugin host is not implemented")
	}
	if kind != "exe" {
		return errors.New("unsupported module kind")
	}
	return nil
}

func cachedArtifact(dataDir string, meta *client.ModuleMeta, api *client.Client) (string, error) {
	dir := filepath.Join(dataDir, "modules", meta.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	dest := filepath.Join(dir, strings.ToLower(meta.SHA256)+".exe")
	if err := verifyArtifact(dest, meta); err == nil {
		cleanStaleArtifacts(dir, filepath.Base(dest))
		return dest, nil
	}
	_ = os.Remove(dest)
	token := make([]byte, 8)
	if _, err := rand.Read(token); err != nil {
		return "", err
	}
	tmp := filepath.Join(dir, ".download-"+hex.EncodeToString(token))
	if err := api.DownloadModule(meta, tmp); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := verifyArtifact(tmp, meta); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Chmod(tmp, 0o700); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, dest); err != nil {
		if verifyArtifact(dest, meta) != nil {
			_ = os.Remove(tmp)
			return "", err
		}
		_ = os.Remove(tmp)
	}
	cleanStaleArtifacts(dir, filepath.Base(dest))
	return dest, nil
}

func verifyArtifact(path string, meta *client.ModuleMeta) error {
	stat, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !stat.Mode().IsRegular() || stat.Size() != meta.Size {
		return errors.New("module artifact size mismatch")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(hash, io.LimitReader(f, client.MaxUpdateBytes+1))
	closeErr := f.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), meta.SHA256) {
		return errors.New("module sha256 mismatch")
	}
	kind, arch, err := inspectPE(path)
	if err != nil {
		return err
	}
	if kind != meta.Kind || arch != meta.Arch {
		return errors.New("module PE metadata mismatch")
	}
	return nil
}

func cleanStaleArtifacts(dir, keep string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() == keep {
			continue
		}
		_ = os.Remove(filepath.Join(dir, entry.Name()))
	}
}

func runExecutable(
	ctx context.Context,
	artifact string,
	meta *client.ModuleMeta,
	args []string,
	progress func(int),
) (any, error) {
	if runtime.GOOS != "windows" {
		return nil, errors.New("exe modules are Windows-only")
	}
	runDir, err := os.MkdirTemp(filepath.Dir(artifact), ".run-")
	if err != nil {
		return nil, errors.New("module run directory unavailable")
	}
	defer os.RemoveAll(runDir)
	cmd := exec.CommandContext(ctx, artifact, args...)
	cmd.Dir = runDir
	cmd.Env = moduleEnv(meta)
	cmd.Stdin = nil
	procutil.Harden(cmd, 10*time.Second)
	procutil.DenyNetwork(cmd)
	stdoutLimit := meta.MaxOutputBytes / 2
	stderrLimit := meta.MaxOutputBytes - stdoutLimit
	stdout := &capBuffer{limit: stdoutLimit}
	stderr := &capBuffer{limit: stderrLimit}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if progress != nil {
		progress(50)
	}
	runErr := cmd.Run()
	result := map[string]any{
		"moduleId":    meta.ID,
		"version":     meta.Version,
		"action":      meta.Action,
		"stdout":      stdout.String(),
		"stderr":      stderr.String(),
		"outputBound": meta.MaxOutputBytes,
	}
	if ctx.Err() != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			result["error"] = "timeout"
			return result, fmt.Errorf("module timeout after %s", time.Duration(meta.TimeoutSec)*time.Second)
		}
		result["error"] = "cancelled"
		return result, ErrCancelled
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			result["exitCode"] = exitErr.ExitCode()
			result["error"] = "nonzero_exit"
			return result, fmt.Errorf("module exited with code %d", exitErr.ExitCode())
		}
		result["error"] = "start_failed"
		return result, errors.New("module process failed to start")
	}
	result["exitCode"] = 0
	if progress != nil {
		progress(100)
	}
	return result, nil
}

func moduleEnv(meta *client.ModuleMeta) []string {
	keys := []string{
		"PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "ProgramData", "PUBLIC",
		"USERPROFILE", "USERNAME", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES",
		"ProgramFiles(x86)", "PATHEXT",
	}
	env := make([]string, 0, len(keys)+3)
	for _, key := range keys {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return append(env, "PC_MODULE_ID="+meta.ID, "PC_MODULE_ACTION="+meta.Action)
}

type capBuffer struct {
	buf   bytes.Buffer
	limit int
}

func (c *capBuffer) Write(p []byte) (int, error) {
	remaining := c.limit - c.buf.Len()
	if remaining > 0 {
		if len(p) < remaining {
			remaining = len(p)
		}
		_, _ = c.buf.Write(p[:remaining])
	}
	return len(p), nil
}

func (c *capBuffer) String() string {
	return c.buf.String()
}
