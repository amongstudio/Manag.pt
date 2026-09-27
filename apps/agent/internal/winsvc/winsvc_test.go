package winsvc

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestHelperCandidatesIncludeDistAndArch(t *testing.T) {
	exe := filepath.Join("C:", "download", AgentExeName())
	got := HelperCandidates(exe)
	if len(got) == 0 {
		t.Fatal("expected candidates")
	}
	joined := strings.Join(got, "\n")
	if !strings.Contains(joined, HelperExeName()) {
		t.Fatalf("missing helper name in %s", joined)
	}
	if runtime.GOOS == "windows" && !strings.Contains(joined, string(filepath.Separator)+"dist"+string(filepath.Separator)) {
		t.Fatalf("expected dist/ candidates: %s", joined)
	}
}

func TestDefaultHelperYAMLNamesAgentService(t *testing.T) {
	body := DefaultHelperYAML()
	if !strings.Contains(body, AgentServiceUnit()) {
		t.Fatalf("yaml: %s", body)
	}
	if !strings.Contains(body, "status_port: 17890") {
		t.Fatalf("yaml: %s", body)
	}
}

func TestAgentServiceConfigIsLocalSystem(t *testing.T) {
	cfg := AgentServiceConfig(InstalledAgentPath())
	if cfg.Name != AgentServiceUnit() {
		t.Fatalf("name: %s", cfg.Name)
	}
	if cfg.UserName != "" {
		t.Fatalf("UserName must be empty (LocalSystem), got %q", cfg.UserName)
	}
	if cfg.Option["OnFailure"] != "restart" {
		t.Fatalf("OnFailure: %v", cfg.Option["OnFailure"])
	}
	h := HelperServiceConfig(InstalledHelperPath())
	if h.UserName != "" {
		t.Fatalf("helper UserName: %q", h.UserName)
	}
}

func TestSamePath(t *testing.T) {
	if !samePath(filepath.Join("a", "b"), filepath.Join("a", "b")) {
		t.Fatal("equal")
	}
	if samePath(filepath.Join("a", "b"), filepath.Join("a", "c")) {
		t.Fatal("different")
	}
}

func TestSidecarYAMLNextToExe(t *testing.T) {
	exe := filepath.Join("C:", "pack", AgentExeName())
	got := SidecarYAML(exe)
	if !strings.HasSuffix(got, "config.yaml") {
		t.Fatalf("got %s", got)
	}
}

func TestHelperMissingWarningMentionsHelper(t *testing.T) {
	if !strings.Contains(HelperMissingWarning, HelperExeName()) && !strings.Contains(strings.ToLower(HelperMissingWarning), "helper") {
		t.Fatalf("warning: %s", HelperMissingWarning)
	}
}

func TestAlreadyInstalledErr(t *testing.T) {
	if alreadyInstalledErr(nil) {
		t.Fatal("nil")
	}
	if !alreadyInstalledErr(errString("service PCManagerAgent already exists")) {
		t.Fatal("expected match")
	}
}

type errString string

func (e errString) Error() string { return string(e) }
