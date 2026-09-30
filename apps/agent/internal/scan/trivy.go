package scan

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"time"
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
	_, err := exec.LookPath("trivy")
	return err == nil
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

func RunTrivy(ctx context.Context, path string) ([]TrivyFinding, error) {
	if !TrivyAvailable() {
		return nil, errors.New("trivy_unavailable")
	}
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "trivy", TrivyArgs(path)...)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil && stdout.Len() == 0 {
		return nil, errors.New("trivy_unavailable")
	}
	return ParseTrivyJSON(stdout.Bytes())
}
