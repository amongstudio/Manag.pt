package scan

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/pc-manager/agent/internal/winreg"
)

type Posture struct {
	Autologon  *bool          `json:"autologon,omitempty"`
	SMBv1      *bool          `json:"smbv1,omitempty"`
	Trivy      string         `json:"trivy"`
	TrivyError string         `json:"trivyError,omitempty"`
	TrivyPaths []string       `json:"trivyPaths,omitempty"`
	Findings   []TrivyFinding `json:"findings,omitempty"`
}

const maxPostureFindings = 2000

// HostPosture reads posture registry values and, when trivy is available,
// runs an offline filesystem vulnerability scan over the configured paths.
// Trivy status: unavailable, scanned, partial, db_missing, failed, or
// no_paths.
func HostPosture(ctx context.Context, scope Scope) Posture {
	out := Posture{Trivy: "unavailable"}
	if TrivyAvailable() {
		out.Trivy, out.TrivyError, out.TrivyPaths, out.Findings = runPostureTrivy(ctx, scope)
	}
	if value, ok := readReg(`SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`, "AutoAdminLogon"); ok {
		enabled := value == "1" || strings.EqualFold(value, "true")
		out.Autologon = &enabled
	}
	if value, ok := readReg(`SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters`, "SMB1"); ok {
		enabled := value == "1" || strings.EqualFold(value, "true")
		out.SMBv1 = &enabled
	}
	return out
}

func postureTrivyPaths(scope Scope) []string {
	candidates := scope.TrivyPaths
	if candidates == nil {
		candidates = defaultTrivyPaths()
	}
	var out []string
	for _, p := range candidates {
		p = strings.TrimSpace(p)
		if p == "" || !filepath.IsAbs(p) {
			continue
		}
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			out = append(out, filepath.Clean(p))
		}
		if len(out) == 8 {
			break
		}
	}
	return out
}

func defaultTrivyPaths() []string {
	if runtime.GOOS == "windows" {
		return []string{os.Getenv("ProgramFiles")}
	}
	return []string{"/opt", "/usr/local"}
}

func runPostureTrivy(ctx context.Context, scope Scope) (string, string, []string, []TrivyFinding) {
	paths := postureTrivyPaths(scope)
	if len(paths) == 0 {
		return "no_paths", "", nil, nil
	}
	timeout := time.Duration(scope.ScanTimeoutMinutes) * time.Minute
	deadline := time.Now().Add(timeout)
	var findings []TrivyFinding
	var lastErr string
	ok := 0
	for _, p := range paths {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			lastErr = "trivy_timeout"
			break
		}
		rows, err := RunTrivy(ctx, p, remaining)
		if err != nil {
			lastErr = err.Error()
			if lastErr == "trivy_db_missing" {
				return "db_missing", lastErr, paths, nil
			}
			continue
		}
		ok++
		findings = append(findings, rows...)
		if len(findings) >= maxPostureFindings {
			findings = findings[:maxPostureFindings]
			break
		}
	}
	switch {
	case ok == 0:
		return "failed", lastErr, paths, nil
	case lastErr != "":
		return "partial", lastErr, paths, findings
	default:
		return "scanned", "", paths, findings
	}
}

func readReg(path, name string) (string, bool) {
	raw, _ := json.Marshal(map[string]string{"hive": "HKLM", "path": path})
	result, err := winreg.Get(raw)
	if err != nil || result == nil {
		return "", false
	}
	for _, value := range result.Values {
		if strings.EqualFold(value.Name, name) {
			text, _ := value.Data.(string)
			if text == "" {
				text = strings.TrimSpace(strings.Trim(strings.ReplaceAll(toString(value.Data), "\n", ""), `"`))
			}
			return text, text != ""
		}
	}
	return "", false
}

func toString(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(raw)
}
