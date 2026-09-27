package netwin

import "testing"

func TestParseNetshRules(t *testing.T) {
	raw := `
Rule Name:                            Core Networking - DHCP (DHCP-In)
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Domain,Private,Public
Grouping:                             Core Networking
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             UDP
LocalPort:                            68
RemotePort:                           67
Action:                               Allow

Rule Name:                            Block SMB
Enabled:                              No
Direction:                            Out
Protocol:                             TCP
LocalPort:                            445
Action:                               Block
`
	rules := parseNetshRules(raw)
	if len(rules) != 2 {
		t.Fatalf("rules %d", len(rules))
	}
	if rules[0].Name != "Core Networking - DHCP (DHCP-In)" || rules[0].Protocol != "udp" || rules[0].LocalPorts != "68" || !rules[0].Enabled {
		t.Fatalf("dhcp %+v", rules[0])
	}
	if rules[1].Direction != "outbound" || rules[1].Action != "block" || rules[1].Enabled {
		t.Fatalf("smb %+v", rules[1])
	}
}

func TestParseNetshRulesSpaceBeforeColon(t *testing.T) {
	raw := `
Rule Name :                           File and Printer Sharing (SMB-In)
Enabled :                             Yes
Direction :                           In
Action :                              Allow
Protocol :                            TCP
LocalPort :                           445
`
	rules := parseNetshRules(raw)
	if len(rules) != 1 || rules[0].Name != "File and Printer Sharing (SMB-In)" || rules[0].LocalPorts != "445" {
		t.Fatalf("%+v", rules)
	}
}

func TestParseNetshProfiles(t *testing.T) {
	raw := `
Domain Profile Settings:
----------------------------------------------------------------------
State                                 ON
Firewall Policy                       BlockInbound,AllowOutbound

Private Profile Settings:
State                                 ON
Firewall Policy                       BlockInbound,AllowOutbound

Public Profile Settings:
State                                 OFF
Firewall Policy                       BlockInbound,AllowOutbound
`
	profiles := parseNetshProfiles(raw)
	if len(profiles) != 3 {
		t.Fatalf("profiles %d %+v", len(profiles), profiles)
	}
	if !profiles[0].Enabled || profiles[0].DefaultInbound != "block" {
		t.Fatalf("domain %+v", profiles[0])
	}
	if profiles[2].Enabled {
		t.Fatalf("public should be off %+v", profiles[2])
	}
}

func TestFitFirewallTruncates(t *testing.T) {
	out := &FirewallResult{Rules: make([]FirewallRule, 0, 2000)}
	for i := 0; i < 2000; i++ {
		out.Rules = append(out.Rules, FirewallRule{
			Name:        "Rule with a reasonably long name for json size " + itoa(i),
			Description: "description text that should be clipped if needed and still take space in the payload",
			Direction:   "inbound",
			Action:      "allow",
			Enabled:     true,
			Protocol:    "tcp",
			LocalPorts:  "1-65535",
			Application: `C:\Program Files\Example\app.exe`,
		})
	}
	fitFirewall(out)
	if !out.Truncated {
		t.Fatal("expected truncated")
	}
	if len(out.Rules) >= 2000 {
		t.Fatalf("did not shrink %d", len(out.Rules))
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [16]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
