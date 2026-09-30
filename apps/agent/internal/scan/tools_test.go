package scan

import (
	"archive/zip"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func TestPinnedReleasesAreOfficialHTTPSWithSHA256(t *testing.T) {
	hexRe := regexp.MustCompile(`^[0-9a-f]{64}$`)
	for tool, byPlatform := range pinnedReleases {
		for platform, rel := range byPlatform {
			if !strings.HasPrefix(rel.URL, "https://github.com/projectdiscovery/") &&
				!strings.HasPrefix(rel.URL, "https://github.com/aquasecurity/") &&
				!strings.HasPrefix(rel.URL, "https://nmap.org/dist/") {
				t.Fatalf("%s %s url %s", tool, platform, rel.URL)
			}
			if !hexRe.MatchString(rel.SHA256) || rel.Version == "" || !strings.Contains(rel.URL, rel.Version) {
				t.Fatalf("%s %s release %+v", tool, platform, rel)
			}
		}
	}
}

func TestSafeJoinRefusesTraversal(t *testing.T) {
	root := t.TempDir()
	for _, bad := range []string{"../evil.exe", "/abs", `..\evil`, "a/../../b", "C:/x", ""} {
		if _, err := safeJoin(root, bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	got, err := safeJoin(root, "nmap-7.92/nmap.exe")
	if err != nil || got != filepath.Join(root, "nmap-7.92", "nmap.exe") {
		t.Fatalf("got=%s err=%v", got, err)
	}
}

func TestExtractZipRejectsSlip(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.zip")
	f, _ := os.Create(archive)
	zw := zip.NewWriter(f)
	w, _ := zw.Create("../escape.txt")
	_, _ = w.Write([]byte("x"))
	_ = zw.Close()
	_ = f.Close()
	if err := extract("zip", archive, filepath.Join(dir, "out")); err == nil {
		t.Fatal("zip slip accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "escape.txt")); err == nil {
		t.Fatal("file escaped")
	}
}

func TestNmapArgsUnprivilegedDropsOSDetection(t *testing.T) {
	raw := NmapArgs("127.0.0.1", 50, false, true)
	if !slices.Contains(raw, "-O") || slices.Contains(raw, "--unprivileged") {
		t.Fatalf("raw=%v", raw)
	}
	unpriv := NmapArgs("127.0.0.1", 50, false, false)
	if slices.Contains(unpriv, "-O") || !slices.Contains(unpriv, "--unprivileged") || !slices.Contains(unpriv, "-sT") {
		t.Fatalf("unpriv=%v", unpriv)
	}
	if unpriv[len(unpriv)-1] != "127.0.0.1" {
		t.Fatalf("target must be last: %v", unpriv)
	}
}

func TestClassifyTrivyError(t *testing.T) {
	if got := classifyTrivyError("FATAL --skip-db-update cannot be specified on the first run"); got != "trivy_db_missing" {
		t.Fatalf("got=%s", got)
	}
	if got := classifyTrivyError("something else"); got != "trivy_failed" {
		t.Fatalf("got=%s", got)
	}
	args := trivyArgsWithCache(`C:\apps`, `C:\cache`)
	if args[0] != "fs" || args[1] != "--cache-dir" || args[len(args)-1] != `C:\apps` {
		t.Fatalf("args=%v", args)
	}
}

func TestParseToolVersion(t *testing.T) {
	if got := parseToolVersion(ToolNmap, "Nmap version 7.92 ( https://nmap.org )\nPlatform: i686"); got != "Nmap version 7.92 ( https://nmap.org )" {
		t.Fatalf("nmap=%q", got)
	}
	if got := parseToolVersion(ToolNuclei, "\n[INF] Nuclei Engine Version: v3.11.1\n"); !strings.Contains(got, "v3.11.1") {
		t.Fatalf("nuclei=%q", got)
	}
}

func TestResolveToolPrefersManagedInstall(t *testing.T) {
	root := t.TempDir()
	SetToolsDir(root)
	defer SetToolsDir("")
	rel, ok := PinnedRelease(ToolTrivy)
	if !ok {
		t.Skip("no pinned trivy for this platform")
	}
	bin := filepath.Join(root, ToolTrivy, rel.Version, filepath.FromSlash(rel.Binary))
	_ = os.MkdirAll(filepath.Dir(bin), 0o755)
	_ = os.WriteFile(bin, []byte("x"), 0o755)
	got, source, err := ResolveTool(ToolTrivy)
	if err != nil || got != bin || source != "managed" {
		t.Fatalf("got=%s source=%s err=%v", got, source, err)
	}
}
