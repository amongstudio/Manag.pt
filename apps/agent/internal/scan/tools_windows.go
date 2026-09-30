//go:build windows

package scan

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

func machinePathDirs() []string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`, registry.QUERY_VALUE)
	if err != nil {
		return nil
	}
	defer k.Close()
	raw, _, err := k.GetStringValue("Path")
	if err != nil {
		return nil
	}
	var out []string
	for _, part := range strings.Split(raw, ";") {
		part = strings.TrimSpace(os.ExpandEnv(expandWinEnv(part)))
		if part != "" && filepath.IsAbs(part) {
			out = append(out, part)
		}
	}
	return out
}

func expandWinEnv(s string) string {
	for {
		start := strings.Index(s, "%")
		if start < 0 {
			return s
		}
		end := strings.Index(s[start+1:], "%")
		if end < 0 {
			return s
		}
		name := s[start+1 : start+1+end]
		s = s[:start] + os.Getenv(name) + s[start+2+end:]
	}
}

func knownToolDirs(tool string) []string {
	var out []string
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
		base := os.Getenv(env)
		if base == "" {
			continue
		}
		switch tool {
		case ToolNmap:
			out = append(out, filepath.Join(base, "Nmap"))
		case ToolNuclei:
			out = append(out, filepath.Join(base, "nuclei"))
		case ToolTrivy:
			out = append(out, filepath.Join(base, "trivy"))
		}
	}
	return out
}

// RawScanCapable reports whether Npcap is installed so nmap can use raw
// sockets (SYN scan and OS detection).
func RawScanCapable() bool {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	if isFile(filepath.Join(root, "System32", "Npcap", "wpcap.dll")) {
		return true
	}
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Services\npcap`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	k.Close()
	return true
}
