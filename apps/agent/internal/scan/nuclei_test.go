package scan

import (
	"os"
	"strings"
	"testing"
)

func TestNucleiArgsAlwaysExcludeExploitTags(t *testing.T) {
	args := strings.Join(NucleiArgs("http://127.0.0.1"), " ")
	for _, want := range []string{"-severity critical,high,medium", "-exclude-tags dos,intrusive,fuzz,exploit", "-jsonl", "-no-interactsh"} {
		if !strings.Contains(args, want) {
			t.Fatalf("missing %s in %s", want, args)
		}
	}
	if strings.Contains(args, " -tags ") || strings.Contains(args, "update-templates") {
		t.Fatalf("unsafe args %s", args)
	}
}

func TestParseNucleiFixtureDropsDoS(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/nuclei.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseNucleiJSONL(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("%d findings", len(got))
	}
	if got[0].TemplateID != "tls-version" || got[0].MatchedAt != "https://127.0.0.1:443" {
		t.Fatalf("%+v", got[0])
	}
	if got[1].CVE != "CVE-2024-1000" || got[1].CVSS != 8.1 {
		t.Fatalf("%+v", got[1])
	}
}
