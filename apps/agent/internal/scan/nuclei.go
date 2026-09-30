package scan

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"time"
)

var forbiddenNucleiTags = map[string]struct{}{
	"dos": {}, "intrusive": {}, "fuzz": {}, "exploit": {},
}

type NucleiFinding struct {
	TemplateID  string   `json:"templateId"`
	Name        string   `json:"name"`
	Severity    string   `json:"severity"`
	Description string   `json:"description"`
	MatchedAt   string   `json:"matchedAt"`
	Host        string   `json:"host"`
	CVE         string   `json:"cve,omitempty"`
	CVSS        float64  `json:"cvss,omitempty"`
	Remediation string   `json:"remediation,omitempty"`
	Tags        []string `json:"tags,omitempty"`
}

func NucleiArgs(target string) []string {
	return []string{
		"-u", target,
		"-severity", "critical,high,medium",
		"-exclude-tags", "dos,intrusive,fuzz,exploit",
		"-jsonl",
		"-silent",
		"-no-interactsh",
	}
}

func NucleiAvailable() bool {
	_, err := exec.LookPath("nuclei")
	return err == nil
}

func ParseNucleiJSONL(raw []byte) ([]NucleiFinding, error) {
	var out []NucleiFinding
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			return nil, err
		}
		info, _ := row["info"].(map[string]any)
		tags := stringList(info["tags"])
		if hasForbiddenTag(tags) {
			continue
		}
		finding := NucleiFinding{
			TemplateID:  str(row["template-id"]),
			Name:        str(info["name"]),
			Severity:    strings.ToLower(str(info["severity"])),
			Description: str(info["description"]),
			MatchedAt:   str(row["matched-at"]),
			Host:        str(row["host"]),
			Remediation: str(info["remediation"]),
			Tags:        tags,
		}
		if class, ok := info["classification"].(map[string]any); ok {
			ids := stringList(class["cve-id"])
			if len(ids) > 0 {
				finding.CVE = strings.ToUpper(ids[0])
			}
			switch score := class["cvss-score"].(type) {
			case float64:
				finding.CVSS = score
			}
		}
		if finding.TemplateID == "" && finding.Name == "" {
			continue
		}
		out = append(out, finding)
	}
	return out, scanner.Err()
}

func hasForbiddenTag(tags []string) bool {
	for _, tag := range tags {
		if _, ok := forbiddenNucleiTags[strings.ToLower(tag)]; ok {
			return true
		}
	}
	return false
}

func stringList(value any) []string {
	switch typed := value.(type) {
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := str(item); text != "" {
				out = append(out, text)
			}
		}
		return out
	case []string:
		return typed
	case string:
		parts := strings.Split(typed, ",")
		out := make([]string, 0, len(parts))
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part != "" {
				out = append(out, part)
			}
		}
		return out
	default:
		return nil
	}
}

func str(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func RunNuclei(ctx context.Context, target string, timeout time.Duration) ([]NucleiFinding, error) {
	if !NucleiAvailable() {
		return nil, errors.New("nuclei_unavailable")
	}
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "nuclei", NucleiArgs(target)...)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stdout
	err := cmd.Run()
	if stdout.Len() == 0 && err != nil {
		return nil, err
	}
	return ParseNucleiJSONL(stdout.Bytes())
}
