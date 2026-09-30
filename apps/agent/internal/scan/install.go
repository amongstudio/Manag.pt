package scan

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/pc-manager/agent/internal/procutil"
)

// ToolRelease is an official upstream release pinned by version and SHA-256
// (taken from the project's published checksum file).
type ToolRelease struct {
	Version string
	URL     string
	SHA256  string
	Archive string // "zip" or "tar.gz"
	Binary  string // slash path inside the extracted archive
	Runtime string // optional bundled prerequisite installer (slash path)
}

var pinnedReleases = map[string]map[string]ToolRelease{
	ToolNuclei: {
		"windows/amd64": {
			Version: "3.11.1",
			URL:     "https://github.com/projectdiscovery/nuclei/releases/download/v3.11.1/nuclei_3.11.1_windows_amd64.zip",
			SHA256:  "bb6cb9ff8939b753f6fcab06fd30a15f5bc61d8382a597871334c007a85ff9d2",
			Archive: "zip",
			Binary:  "nuclei.exe",
		},
		"linux/amd64": {
			Version: "3.11.1",
			URL:     "https://github.com/projectdiscovery/nuclei/releases/download/v3.11.1/nuclei_3.11.1_linux_amd64.zip",
			SHA256:  "ea63d4ae232808cd7c6bc00d0142428e231fab59dae01042246097d195835ab6",
			Archive: "zip",
			Binary:  "nuclei",
		},
		"linux/arm64": {
			Version: "3.11.1",
			URL:     "https://github.com/projectdiscovery/nuclei/releases/download/v3.11.1/nuclei_3.11.1_linux_arm64.zip",
			SHA256:  "8044e3d9768ba0a744b2872c1a87e813006f013da97ca9f50f7661a4203bec07",
			Archive: "zip",
			Binary:  "nuclei",
		},
	},
	ToolTrivy: {
		"windows/amd64": {
			Version: "0.74.0",
			URL:     "https://github.com/aquasecurity/trivy/releases/download/v0.74.0/trivy_0.74.0_windows-64bit.zip",
			SHA256:  "94c40e0696e4b907a74b7b2e1438d5d72ebaca83115817407f568a002d520842",
			Archive: "zip",
			Binary:  "trivy.exe",
		},
		"linux/amd64": {
			Version: "0.74.0",
			URL:     "https://github.com/aquasecurity/trivy/releases/download/v0.74.0/trivy_0.74.0_Linux-64bit.tar.gz",
			SHA256:  "2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a",
			Archive: "tar.gz",
			Binary:  "trivy",
		},
		"linux/arm64": {
			Version: "0.74.0",
			URL:     "https://github.com/aquasecurity/trivy/releases/download/v0.74.0/trivy_0.74.0_Linux-ARM64.tar.gz",
			SHA256:  "b94ce1976bbf3c15b514b605ee88be7c6d94a29be2302847ff01cb794d47aad5",
			Archive: "tar.gz",
			Binary:  "trivy",
		},
	},
	// 7.92 is the newest nmap release published as a Windows zip; later
	// releases ship only an interactive installer.
	ToolNmap: {
		"windows/amd64": {
			Version: "7.92",
			URL:     "https://nmap.org/dist/nmap-7.92-win32.zip",
			SHA256:  "b54c54d4b478cad19567a504c7c6b7230dfd80acd881dc2e9015a628a3efa71e",
			Archive: "zip",
			Binary:  "nmap-7.92/nmap.exe",
			Runtime: "nmap-7.92/vcredist_x86.exe",
		},
	},
}

func PinnedRelease(tool string) (ToolRelease, bool) {
	rel, ok := pinnedReleases[tool][runtime.GOOS+"/"+runtime.GOARCH]
	return rel, ok
}

const (
	maxDownloadBytes = 256 << 20
	maxExtractBytes  = 768 << 20
	maxArchiveFiles  = 20000
)

var installMu sync.Mutex

// InstallTool downloads the pinned official release, verifies its SHA-256,
// extracts it under ToolsDir, and confirms the binary runs.
func InstallTool(ctx context.Context, tool string) (map[string]any, error) {
	rel, ok := PinnedRelease(tool)
	if !ok {
		return nil, errors.New("install_unsupported_platform")
	}
	root := ToolsDir()
	if root == "" {
		return nil, errors.New("tools_dir_unset")
	}
	if !installMu.TryLock() {
		return nil, errors.New("install_in_progress")
	}
	defer installMu.Unlock()

	toolRoot := filepath.Join(root, tool)
	if err := os.MkdirAll(toolRoot, 0o755); err != nil {
		return nil, fmt.Errorf("tools_dir: %w", err)
	}
	archivePath := filepath.Join(toolRoot, "download.tmp")
	defer os.Remove(archivePath)
	sum, err := download(ctx, rel.URL, archivePath)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(sum, rel.SHA256) {
		return map[string]any{"expected": rel.SHA256, "actual": sum}, errors.New("checksum_mismatch")
	}
	staging := filepath.Join(toolRoot, rel.Version+".staging")
	_ = os.RemoveAll(staging)
	if err := extract(rel.Archive, archivePath, staging); err != nil {
		_ = os.RemoveAll(staging)
		return nil, err
	}
	final := filepath.Join(toolRoot, rel.Version)
	_ = os.RemoveAll(final)
	if err := os.Rename(staging, final); err != nil {
		_ = os.RemoveAll(staging)
		return nil, fmt.Errorf("install_move: %w", err)
	}
	bin := filepath.Join(final, filepath.FromSlash(rel.Binary))
	if runtime.GOOS != "windows" {
		_ = os.Chmod(bin, 0o755)
	}
	out := map[string]any{"tool": tool, "version": rel.Version, "path": bin, "sha256": sum}
	version, verr := toolVersion(ctx, tool, bin)
	if verr != nil && version == "" && rel.Runtime != "" {
		if rerr := installRuntime(ctx, filepath.Join(final, filepath.FromSlash(rel.Runtime))); rerr != nil {
			out["runtimeError"] = rerr.Error()
		} else {
			out["runtimeInstalled"] = true
		}
		version, verr = toolVersion(ctx, tool, bin)
	}
	if verr != nil && version == "" {
		return out, errors.New(tool + "_not_runnable")
	}
	out["reported"] = version
	if tool == ToolTrivy {
		if err := downloadTrivyDB(ctx, bin); err != nil {
			out["dbError"] = err.Error()
		} else {
			out["dbReady"] = true
		}
	}
	if tool == ToolNmap && !RawScanCapable() {
		out["note"] = "Npcap is not installed; scans use --unprivileged TCP connect mode without OS detection."
	}
	return out, nil
}

func download(ctx context.Context, url, dest string) (string, error) {
	dlCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(dlCtx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("download_failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download_failed: http %d", resp.StatusCode)
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxDownloadBytes+1))
	cerr := f.Close()
	if err != nil {
		return "", fmt.Errorf("download_failed: %w", err)
	}
	if cerr != nil {
		return "", cerr
	}
	if n > maxDownloadBytes {
		return "", errors.New("download_too_large")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// safeJoin rejects absolute paths and parent traversal (zip-slip).
func safeJoin(root, name string) (string, error) {
	clean := path.Clean(strings.ReplaceAll(name, `\`, "/"))
	if clean == "." || strings.HasPrefix(clean, "/") || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, ":") {
		return "", fmt.Errorf("archive_path_refused: %s", name)
	}
	return filepath.Join(root, filepath.FromSlash(clean)), nil
}

func extract(kind, archive, dest string) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	switch kind {
	case "zip":
		return extractZip(archive, dest)
	case "tar.gz":
		return extractTarGz(archive, dest)
	default:
		return errors.New("archive_unsupported")
	}
}

func extractZip(archive, dest string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return fmt.Errorf("archive_invalid: %w", err)
	}
	defer zr.Close()
	if len(zr.File) > maxArchiveFiles {
		return errors.New("archive_too_many_files")
	}
	var total int64
	for _, f := range zr.File {
		target, err := safeJoin(dest, f.Name)
		if err != nil {
			return err
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if !f.Mode().IsRegular() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		n, err := writeFile(target, rc, maxExtractBytes-total)
		rc.Close()
		if err != nil {
			return err
		}
		total += n
	}
	return nil
}

func extractTarGz(archive, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("archive_invalid: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var total int64
	for files := 0; ; files++ {
		if files > maxArchiveFiles {
			return errors.New("archive_too_many_files")
		}
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("archive_invalid: %w", err)
		}
		target, err := safeJoin(dest, hdr.Name)
		if err != nil {
			return err
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			n, err := writeFile(target, tr, maxExtractBytes-total)
			if err != nil {
				return err
			}
			total += n
		}
	}
}

func writeFile(target string, r io.Reader, budget int64) (int64, error) {
	if budget <= 0 {
		return 0, errors.New("archive_too_large")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return 0, err
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, io.LimitReader(r, budget+1))
	cerr := out.Close()
	if err != nil {
		return n, err
	}
	if n > budget {
		return n, errors.New("archive_too_large")
	}
	return n, cerr
}

// installRuntime runs the prerequisite installer bundled in the verified
// archive (the Microsoft VC++ x86 runtime for nmap) with fixed quiet flags.
func installRuntime(ctx context.Context, installer string) error {
	if !isFile(installer) {
		return errors.New("runtime_installer_missing")
	}
	runCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(runCtx, installer, "/install", "/quiet", "/norestart")
	procutil.Harden(cmd, 10*time.Second)
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		// 3010: success, reboot required; 1638: newer version already installed.
		if errors.As(err, &exit) && (exit.ExitCode() == 3010 || exit.ExitCode() == 1638) {
			return nil
		}
		return fmt.Errorf("runtime_install_failed: %w", err)
	}
	return nil
}

func downloadTrivyDB(ctx context.Context, bin string) error {
	cache := managedCacheDir(ToolTrivy)
	if err := os.MkdirAll(cache, 0o755); err != nil {
		return err
	}
	runCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(runCtx, bin, "image", "--download-db-only", "--no-progress", "--cache-dir", cache)
	procutil.Harden(cmd, 10*time.Second)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 300 {
			msg = msg[len(msg)-300:]
		}
		return fmt.Errorf("trivy_db_download_failed: %s", msg)
	}
	return nil
}
