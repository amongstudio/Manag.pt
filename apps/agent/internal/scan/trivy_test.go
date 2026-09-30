package scan

import (
	"strings"
	"testing"
)

func TestTrivyArgsAreOffline(t *testing.T) {
	args := strings.Join(TrivyArgs("/var/lib/dpkg"), " ")
	if !strings.Contains(args, "--offline-scan") || !strings.Contains(args, "--skip-db-update") {
		t.Fatal(args)
	}
	if strings.Contains(args, "http") {
		t.Fatal(args)
	}
}

func TestParseTrivyFixture(t *testing.T) {
	raw := []byte(`{"Results":[{"Vulnerabilities":[{"VulnerabilityID":"CVE-2024-1","Severity":"HIGH","PkgName":"curl","InstalledVersion":"7.8","Title":"curl issue"}]}]}`)
	got, err := ParseTrivyJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].CVE != "CVE-2024-1" || got[0].Package != "curl" {
		t.Fatalf("%+v", got)
	}
}
