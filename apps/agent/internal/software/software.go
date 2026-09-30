// Package software runs audited install/uninstall actions without a shell.
// Every child process gets a fixed argv built from allowlisted values.
package software

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"strings"
)

// Patterns mirror packages/shared/src/admin-actions.ts.
var (
	wingetIDRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`)
	versionRe     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)
	productCodeRe = regexp.MustCompile(`^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$`)
	msiInUninst   = regexp.MustCompile(`(?i)^"?(?:[a-z]:\\[^"]*\\)?msiexec(?:\.exe)?"?\s+/[ix]\s*(\{[0-9A-Fa-f-]{36}\})\s*$`)
)

const outputCap = 65536

type InstallRequest struct {
	Name    string `json:"name"`
	ID      string `json:"id"`
	Version string `json:"version"`
	Scope   string `json:"scope"`
}

type UninstallRequest struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	ProductCode string `json:"productCode"`
	WingetID    string `json:"wingetId"`
}

func ParseInstall(raw json.RawMessage) (InstallRequest, error) {
	var req InstallRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return req, errors.New("invalid_payload")
	}
	req.ID = strings.TrimSpace(req.ID)
	req.Name = strings.TrimSpace(req.Name)
	if req.ID == "" {
		req.ID = req.Name
	}
	if !wingetIDRe.MatchString(req.ID) {
		return req, errors.New("invalid_package_id")
	}
	if req.Version != "" && !versionRe.MatchString(req.Version) {
		return req, errors.New("invalid_package_version")
	}
	if req.Scope != "" && req.Scope != "machine" && req.Scope != "user" {
		return req, errors.New("invalid_scope")
	}
	return req, nil
}

func ParseUninstall(raw json.RawMessage) (UninstallRequest, error) {
	var req UninstallRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return req, errors.New("invalid_payload")
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || strings.HasPrefix(req.Name, "-") || strings.ContainsAny(req.Name, "\r\n\x00") || len(req.Name) > 256 {
		return req, errors.New("invalid_package_name")
	}
	if req.ProductCode != "" && !productCodeRe.MatchString(req.ProductCode) {
		return req, errors.New("invalid_product_code")
	}
	if req.WingetID != "" && !wingetIDRe.MatchString(req.WingetID) {
		return req, errors.New("invalid_package_id")
	}
	if len(req.Version) > 128 || strings.ContainsAny(req.Version, "\r\n\x00") {
		return req, errors.New("invalid_package_version")
	}
	return req, nil
}

// WingetInstallArgs installs exactly one package from the winget source,
// silently, with agreements accepted up front so it cannot prompt.
func WingetInstallArgs(req InstallRequest) []string {
	args := []string{"install", "--id", req.ID, "--exact", "--silent", "--source", "winget",
		"--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"}
	if req.Version != "" {
		args = append(args, "--version", req.Version)
	}
	if req.Scope != "" {
		args = append(args, "--scope", req.Scope)
	}
	return args
}

func WingetUninstallArgs(req UninstallRequest) []string {
	args := []string{"uninstall"}
	if req.WingetID != "" {
		args = append(args, "--id", req.WingetID)
	} else {
		args = append(args, "--name", req.Name)
	}
	return append(args, "--exact", "--silent", "--accept-source-agreements", "--disable-interactivity")
}

func MsiUninstallArgs(productCode string) []string {
	return []string{"/x", productCode, "/qn", "/norestart"}
}

// MsiProductCodeFromUninstallString extracts the GUID from the common
// `MsiExec.exe /I{GUID}` or `/X{GUID}` registry uninstall strings.
func MsiProductCodeFromUninstallString(s string) (string, bool) {
	m := msiInUninst.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil || !productCodeRe.MatchString(m[1]) {
		return "", false
	}
	return strings.ToUpper(m[1]), true
}

var refusedUninstallers = map[string]struct{}{
	"cmd.exe": {}, "powershell.exe": {}, "pwsh.exe": {}, "wscript.exe": {}, "cscript.exe": {},
	"mshta.exe": {}, "rundll32.exe": {}, "regsvr32.exe": {}, "bash.exe": {}, "wsl.exe": {},
	"conhost.exe": {}, "explorer.exe": {}, "msiexec.exe": {},
}

// ValidateQuietUninstall accepts a vendor QuietUninstallString argv only if
// it runs an absolute .exe that is not a shell, script host, or proxy loader.
func ValidateQuietUninstall(argv []string) error {
	if len(argv) == 0 {
		return errors.New("uninstall_string_empty")
	}
	exe := argv[0]
	if !isAbsWindowsPath(exe) || !strings.EqualFold(filepath.Ext(exe), ".exe") {
		return errors.New("uninstall_string_refused")
	}
	base := strings.ToLower(exe[strings.LastIndexAny(exe, `\/`)+1:])
	if _, bad := refusedUninstallers[base]; bad {
		return errors.New("uninstall_string_refused")
	}
	for _, arg := range argv[1:] {
		if strings.ContainsAny(arg, "\r\n\x00") {
			return errors.New("uninstall_string_refused")
		}
	}
	return nil
}

func isAbsWindowsPath(p string) bool {
	return len(p) >= 3 && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) && p[1] == ':' && (p[2] == '\\' || p[2] == '/')
}

func capOutput(b []byte) string {
	s := string(b)
	if len(s) > outputCap {
		s = s[:outputCap]
	}
	return s
}
