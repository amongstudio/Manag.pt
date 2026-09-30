package scan

import (
	"os"
	"testing"
)

func TestParseNmapFixture(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/nmap-localhost.xml")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseNmapXML(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Hosts) != 1 || got.Hosts[0].IP != "127.0.0.1" || got.Hosts[0].Hostname != "localhost" {
		t.Fatalf("%+v", got.Hosts)
	}
	if got.Hosts[0].OS != "Linux 6.1" {
		t.Fatalf("os %q", got.Hosts[0].OS)
	}
	open := 0
	for _, port := range got.Hosts[0].Ports {
		if port.State == "open" {
			open++
		}
		if port.Port == 22 && (port.Product != "OpenSSH" || port.Version != "9.6") {
			t.Fatalf("ssh %+v", port)
		}
	}
	if open != 2 {
		t.Fatalf("open %d", open)
	}
}

func TestParseVulnersFixture(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/nmap-vulners.xml")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseNmapXML(raw)
	if err != nil {
		t.Fatal(err)
	}
	ports := got.Hosts[0].Ports
	if len(ports) != 1 || len(ports[0].CVEs) != 1 || ports[0].CVEs[0].ID != "CVE-2023-38408" {
		t.Fatalf("%+v", ports)
	}
	if ports[0].CVEs[0].CVSS != 9.8 {
		t.Fatalf("cvss %v", ports[0].CVEs[0].CVSS)
	}
}
