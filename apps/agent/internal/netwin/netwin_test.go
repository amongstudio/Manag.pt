package netwin

import (
	"encoding/json"
	"errors"
	"runtime"
	"testing"
)

func TestValidateNameAndParse(t *testing.T) {
	if _, err := ValidateName(""); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("empty: %v", err)
	}
	if _, err := ValidateName("bad\nname"); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("newline: %v", err)
	}
	got, err := ValidateName("  Peer LAN  ")
	if err != nil || got != "Peer LAN" {
		t.Fatalf("got %q %v", got, err)
	}
	req, err := ParsePorts([]byte(`{"listenOnly":true}`))
	if err != nil || !req.ListenOnly {
		t.Fatalf("ports: %+v %v", req, err)
	}
	if _, err := ParsePorts([]byte(`{`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("bad ports json: %v", err)
	}
	name, err := ParseDelete([]byte(`{"name":"Allow SSH"}`))
	if err != nil || name != "Allow SSH" {
		t.Fatalf("delete %q %v", name, err)
	}
	if _, err := ParseDelete([]byte(`{}`)); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("missing name: %v", err)
	}
	rule, err := ParseRule([]byte(`{"name":"Peer 17891","direction":"inbound","action":"allow","protocol":"tcp","localPorts":"17891","enabled":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if rule.Name != "Peer 17891" || rule.Direction != "inbound" || rule.Protocol != "tcp" || rule.LocalPorts != "17891" || rule.Enabled == nil || !*rule.Enabled {
		t.Fatalf("rule %+v", rule)
	}
	off, err := ParseRule([]byte(`{"name":"Off","enabled":false}`))
	if err != nil || off.Enabled == nil || *off.Enabled {
		t.Fatalf("enabled false %+v %v", off, err)
	}
	if _, err := ParseRule([]byte(`{"name":"x","protocol":"esp"}`)); !errors.Is(err, ErrInvalidProtocol) {
		t.Fatalf("protocol: %v", err)
	}
	if _, err := ParseRule([]byte(`{"name":"x","profiles":"evil"}`)); !errors.Is(err, ErrInvalidRule) {
		t.Fatalf("profiles: %v", err)
	}
	p := Port{LocalPort: OfficialPort}
	markOfficial(&p)
	if !p.Official {
		t.Fatal("official peer port")
	}
}

func TestUnsupportedPlatform(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows implements IP Helper and INetFwPolicy2")
	}
	if _, err := Adapters(); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Adapters: %v", err)
	}
	if _, err := Ports(PortsRequest{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Ports: %v", err)
	}
	if _, err := Firewall(); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Firewall: %v", err)
	}
	if _, err := SetRule(RuleRequest{Name: "x"}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("SetRule: %v", err)
	}
	if _, err := DeleteRule("x"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("DeleteRule: %v", err)
	}
}

func TestWindowsReadsDoNotPanic(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip()
	}
	adapters, err := Adapters()
	if err != nil {
		t.Fatalf("Adapters: %v", err)
	}
	raw, err := json.Marshal(adapters)
	if err != nil || len(raw) < 2 {
		t.Fatalf("adapters json %s %v", raw, err)
	}
	if adapters == nil || adapters.Adapters == nil {
		t.Fatal("expected adapters slice")
	}
	ports, err := Ports(PortsRequest{ListenOnly: true})
	if err != nil {
		t.Fatalf("Ports: %v", err)
	}
	if ports == nil || ports.Ports == nil {
		t.Fatal("expected ports slice")
	}
	for _, p := range ports.Ports {
		if p.Protocol == "tcp" && p.State != "listen" {
			t.Fatalf("listenOnly leaked %s %s", p.Protocol, p.State)
		}
		if p.LocalPort == OfficialPort && !p.Official {
			t.Fatal("17891 should be official")
		}
	}
	fw, err := Firewall()
	if err != nil {
		if errors.Is(err, ErrAccessDenied) {
			t.Skip("firewall_access_denied")
		}
		t.Fatalf("Firewall: %v", err)
	}
	if fw == nil || fw.Profiles == nil || fw.Rules == nil {
		t.Fatal("expected firewall result")
	}
	if len(fw.Profiles) != 3 {
		t.Fatalf("expected 3 profiles, got %d", len(fw.Profiles))
	}
	if len(fw.Rules) == 0 {
		t.Fatal("expected firewall rules from INetFwPolicy2")
	}
}
