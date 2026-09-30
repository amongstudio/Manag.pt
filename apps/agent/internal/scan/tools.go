package scan

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/pc-manager/agent/internal/procutil"
)

// Tool names match SCAN_TOOLS in packages/shared.
const (
	ToolNmap   = "nmap"
	ToolNuclei = "nuclei"
	ToolTrivy  = "trivy"
)

var Tools = []string{ToolNmap, ToolNuclei, ToolTrivy}

var (
	toolsMu  sync.RWMutex
	toolsDir string
)

// SetToolsDir sets the agent-managed install root (<DataDir>/tools). It must
// be writable only by administrators/SYSTEM because binaries found there run
// as the agent.
func SetToolsDir(dir string) {
	toolsMu.Lock()
	toolsDir = dir
	toolsMu.Unlock()
}

func ToolsDir() string {
	toolsMu.RLock()
	defer toolsMu.RUnlock()
	return toolsDir
}

func binaryName(tool string) string {
	if runtime.GOOS == "windows" {
		return tool + ".exe"
	}
	return tool
}

// managedPath is the pinned install location for tool, or "" when unknown.
func managedPath(tool string) string {
	root := ToolsDir()
	rel, ok := PinnedRelease(tool)
	if root == "" || !ok {
		return ""
	}
	return filepath.Join(root, tool, rel.Version, filepath.FromSlash(rel.Binary))
}

func managedCacheDir(tool string) string {
	root := ToolsDir()
	if root == "" {
		return ""
	}
	return filepath.Join(root, tool, "cache")
}

func isFile(path string) bool {
	if path == "" {
		return false
	}
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

// ToolStatus is reported by get_scan_tools.
type ToolStatus struct {
	Tool       string   `json:"tool"`
	Available  bool     `json:"available"`
	Path       string   `json:"path,omitempty"`
	Source     string   `json:"source,omitempty"`
	Version    string   `json:"version,omitempty"`
	Pinned     string   `json:"pinned,omitempty"`
	CanInstall bool     `json:"canInstall"`
	Error      string   `json:"error,omitempty"`
	Notes      []string `json:"notes,omitempty"`
}

// ResolveTool finds an executable for tool without trusting user-writable
// locations: the agent-managed pinned install, the service PATH, the machine
// PATH from the registry (so installs after service start are seen), and
// vendor default install directories.
func ResolveTool(tool string) (string, string, error) {
	if p := managedPath(tool); isFile(p) {
		return p, "managed", nil
	}
	if p, err := exec.LookPath(tool); err == nil {
		if abs, err := filepath.Abs(p); err == nil {
			return abs, "path", nil
		}
		return p, "path", nil
	}
	name := binaryName(tool)
	for _, dir := range machinePathDirs() {
		if p := filepath.Join(dir, name); isFile(p) {
			return p, "machine_path", nil
		}
	}
	for _, dir := range knownToolDirs(tool) {
		if p := filepath.Join(dir, name); isFile(p) {
			return p, "default_dir", nil
		}
	}
	return "", "", errors.New(tool + "_unavailable")
}

func toolVersion(ctx context.Context, tool, path string) (string, error) {
	flag := "--version"
	if tool == ToolNuclei {
		flag = "-version"
	}
	runCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(runCtx, path, flag)
	procutil.Harden(cmd, 5*time.Second)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return parseToolVersion(tool, out.String()), err
}

func parseToolVersion(tool, raw string) string {
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		lower := strings.ToLower(line)
		if tool == ToolNuclei && !strings.Contains(lower, "version") {
			continue
		}
		if len(line) > 160 {
			line = line[:160]
		}
		return line
	}
	return ""
}

// Status resolves every tool and probes its version.
func Status(ctx context.Context) []ToolStatus {
	out := make([]ToolStatus, 0, len(Tools))
	for _, tool := range Tools {
		st := ToolStatus{Tool: tool}
		if rel, ok := PinnedRelease(tool); ok {
			st.Pinned = rel.Version
			st.CanInstall = true
		}
		path, source, err := ResolveTool(tool)
		if err != nil {
			st.Error = err.Error()
		} else {
			st.Path, st.Source = path, source
			version, verr := toolVersion(ctx, tool, path)
			st.Version = version
			if verr != nil && version == "" {
				st.Error = tool + "_not_runnable"
			} else {
				st.Available = true
			}
		}
		if tool == ToolNmap && st.Available && !RawScanCapable() {
			st.Notes = append(st.Notes, "Npcap not installed: scans run with --unprivileged (TCP connect, no OS detection).")
		}
		if tool == ToolTrivy && st.Available && !trivyDBPresent() {
			st.Notes = append(st.Notes, "Vulnerability DB not downloaded: run Install to fetch it.")
		}
		out = append(out, st)
	}
	return out
}

func trivyDBPresent() bool {
	dir := managedCacheDir(ToolTrivy)
	return dir != "" && isFile(filepath.Join(dir, "db", "trivy.db"))
}
