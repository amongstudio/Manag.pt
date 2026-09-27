package notify

import (
	"os"
	"path/filepath"
	"strings"
)

const (
	aliveFile   = "agent.alive"
	versionFile = "agent.version"
)

func alivePath(dataDir string) string {
	return filepath.Join(dataDir, aliveFile)
}

func versionPath(dataDir string) string {
	return filepath.Join(dataDir, versionFile)
}

// TakeUncleanStart is true when the previous process died without Stop.
func TakeUncleanStart(dataDir string) bool {
	if strings.TrimSpace(dataDir) == "" {
		return false
	}
	_, err := os.Stat(alivePath(dataDir))
	return err == nil
}

func MarkAlive(dataDir string) {
	if strings.TrimSpace(dataDir) == "" {
		return
	}
	_ = os.MkdirAll(dataDir, 0o755)
	_ = os.WriteFile(alivePath(dataDir), []byte("1\n"), 0o600)
}

func MarkCleanStop(dataDir string) {
	if strings.TrimSpace(dataDir) == "" {
		return
	}
	_ = os.Remove(alivePath(dataDir))
}

// NoteVersion records the running agent version. changed is true when a
// previous version file existed and differed (used for update_applied).
func NoteVersion(dataDir, version string) (previous string, changed bool) {
	version = strings.TrimSpace(version)
	if strings.TrimSpace(dataDir) == "" || version == "" {
		return "", false
	}
	path := versionPath(dataDir)
	raw, err := os.ReadFile(path)
	previous = strings.TrimSpace(string(raw))
	if err == nil && previous != "" && previous != version {
		changed = true
	}
	_ = os.MkdirAll(dataDir, 0o755)
	_ = os.WriteFile(path, []byte(version+"\n"), 0o600)
	return previous, changed
}
