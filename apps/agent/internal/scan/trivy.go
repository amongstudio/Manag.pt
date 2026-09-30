package scan

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"time"

	"github.com/pc-manager/agent/internal/procutil"
)

type TrivyFinding struct {
	CVE      string `json:"cve"`
	Severity string `json:"severity"`
	Package  string `json:"package"`
	Version  string `json:"version"`
	Title    string `json:"title"`
}

func TrivyArgs(path string) []string {
	return []string{"fs", "--scanners", "vuln", "--format", "json", "--offline-scan", "--skip-db-update", path}
}

func TrivyAvailable() bool {
	_, _, err := ResolveTool(ToolTrivy)
	return err == nil
}

func trivyArgsWithCache(path, cache string) []string {
	args := TrivyArgs(path)
	if cache == "" {
		return args
	}
	return append([]string{args[0], "--cache-dir", cache}, args[1:]...)
}

// classifyTrivyError maps trivy stderr to a stable error code.
func classifyTrivyError(stderr string) string {
	lower := strings.ToLower(stderr)
	switch {
	case strings.Contains(lower, "skip-db-update") || strings.Contains(lower, "cannot skip downloading db") || strings.Contains(lower, "db error") || strings.Contains(lower, "trivy.db"):
		return "trivy_db_missing"
	case strings.Contains(lower, "deadline exceeded") || strings.Contains(lower, "timeout"):
		return "trivy_timeout"
	default:
		return "trivy_failed"
	}
}

func ParseTrivyJSON(raw []byte) ([]TrivyFinding, error) {
	var doc struct {
		Results []struct {
			Vulnerabilities []struct {
				ID        string `json:"VulnerabilityID"`
				Severity  string `json:"Severity"`
				PkgName   string `json:"PkgName"`
				Installed string `json:"InstalledVersion"`
				Title     string `json:"Title"`
			} `json:"Vulnerabilities"`
		} `json:"Results"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	var out []TrivyFinding
	for _, result := range doc.Results {
		for _, vuln := range result.Vulnerabilities {
			if vuln.ID == "" {
				continue
			}
			out = append(out, TrivyFinding{
				CVE:      strings.ToUpper(vuln.ID),
				Severity: strings.ToLower(vuln.Severity),
				Package:  vuln.PkgName,
				Version:  vuln.Installed,
				Title:    vuln.Title,
			})
		}
	}
	return out, nil
}

func RunTrivy(ctx context.Context, path string, timeout time.Duration) ([]TrivyFinding, error) {
	bin, _, err := ResolveTool(ToolTrivy)
	if err != nil {
		return nil, err
	}
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	cache := ""
	if trivyDBPresent() {
		cache = managedCacheDir(ToolTrivy)
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, bin, trivyArgsWithCache(path, cache)...)
	procutil.Harden(cmd, 10*time.Second)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil && stdout.Len() == 0 {
		if runCtx.Err() != nil {
			return nil, errors.New("trivy_timeout")
		}
		return nil, errors.New(classifyTrivyError(stderr.String()))
	}
	return ParseTrivyJSON(stdout.Bytes())
}
