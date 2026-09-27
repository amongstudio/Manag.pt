package netwin

import (
	"encoding/json"
	"errors"
	"strings"
)

var errEmptyJSON = errors.New("empty json")

func parseNetshRules(raw string) []FirewallRule {
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	raw = strings.TrimPrefix(raw, "\ufeff")
	var out []FirewallRule
	var cur []string
	flush := func() {
		if len(cur) == 0 {
			return
		}
		rule := parseNetshRule(strings.Join(cur, "\n"))
		if rule.Name != "" {
			out = append(out, rule)
		}
		cur = nil
	}
	for _, line := range strings.Split(raw, "\n") {
		trim := strings.TrimSpace(line)
		key, _, ok := cutColon(trim)
		if ok && isRuleNameKey(key) {
			flush()
			if len(out) >= maxFirewall {
				return out
			}
		}
		cur = append(cur, line)
	}
	flush()
	return out
}

func parseNetshRule(block string) FirewallRule {
	rule := FirewallRule{Direction: "inbound", Action: "allow", Enabled: true, Protocol: "any"}
	for _, line := range strings.Split(block, "\n") {
		trim := strings.TrimSpace(line)
		if trim == "" || strings.HasPrefix(trim, "---") {
			continue
		}
		key, val, ok := cutColon(trim)
		if !ok {
			continue
		}
		switch strings.ToLower(strings.ReplaceAll(strings.TrimSpace(key), " ", "")) {
		case "rulename", "regelname":
			rule.Name = val
		case "name":
			if rule.Name == "" {
				rule.Name = val
			}
		case "description":
			rule.Description = clipText(val, 160)
		case "enabled":
			rule.Enabled = strings.EqualFold(val, "yes") || strings.EqualFold(val, "true") || strings.EqualFold(val, "on")
		case "direction":
			if strings.EqualFold(val, "out") || strings.EqualFold(val, "outbound") {
				rule.Direction = "outbound"
			} else {
				rule.Direction = "inbound"
			}
		case "profiles", "profile":
			rule.Profiles = netshProfiles(val)
		case "grouping":
			rule.Grouping = val
		case "localip", "localaddress":
			rule.LocalAddresses = emptyAny(val)
		case "remoteip", "remoteaddress":
			rule.RemoteAddresses = emptyAny(val)
		case "protocol":
			rule.Protocol = netshProtocol(val)
		case "localport", "localports":
			rule.LocalPorts = emptyAny(val)
		case "remoteport", "remoteports":
			rule.RemotePorts = emptyAny(val)
		case "program", "application":
			if !strings.EqualFold(val, "any") {
				rule.Application = val
			}
		case "service":
			if !strings.EqualFold(val, "any") {
				rule.ServiceName = val
			}
		case "action":
			if strings.EqualFold(val, "block") || strings.EqualFold(val, "deny") {
				rule.Action = "block"
			} else {
				rule.Action = "allow"
			}
		}
	}
	return rule
}

func isRuleNameKey(key string) bool {
	k := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(key), " ", ""))
	switch k {
	case "rulename", "regelname", "nomdelarègle", "nomdelaregle":
		return true
	default:
		return false
	}
}

func parseNetshProfiles(raw string) []FirewallProfile {
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	lower := strings.ToLower(raw)
	specs := []struct {
		name  string
		match string
	}{
		{"domain", "domain profile"},
		{"private", "private profile"},
		{"public", "public profile"},
	}
	out := make([]FirewallProfile, 0, 3)
	for _, spec := range specs {
		idx := strings.Index(lower, spec.match)
		if idx < 0 {
			continue
		}
		end := nextProfileIndex(lower, idx+len(spec.match))
		chunk := raw[idx:end]
		p := FirewallProfile{Name: spec.name}
		for _, line := range strings.Split(chunk, "\n") {
			key, val, ok := cutColon(strings.TrimSpace(line))
			if !ok {
				key, val, ok = cutSpacedKey(strings.TrimSpace(line))
			}
			if !ok {
				continue
			}
			kl := strings.ToLower(strings.TrimSpace(key))
			switch {
			case kl == "state":
				p.Enabled = strings.EqualFold(val, "on") || strings.EqualFold(val, "yes") || strings.EqualFold(val, "true")
			case strings.Contains(kl, "firewall policy") || kl == "policy":
				in, outAct := netshPolicyActions(val)
				p.DefaultInbound = in
				p.DefaultOutbound = outAct
			}
		}
		out = append(out, p)
	}
	return out
}

func nextProfileIndex(lower string, from int) int {
	keys := []string{"domain profile", "private profile", "public profile"}
	best := -1
	for _, k := range keys {
		i := strings.Index(lower[from:], k)
		if i < 0 {
			continue
		}
		at := from + i
		if best < 0 || at < best {
			best = at
		}
	}
	if best < 0 {
		return len(lower)
	}
	return best
}

func cutSpacedKey(line string) (string, string, bool) {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return "", "", false
	}
	val := fields[len(fields)-1]
	key := strings.Join(fields[:len(fields)-1], " ")
	if key == "" {
		return "", "", false
	}
	return key, val, true
}

func netshPolicyActions(v string) (string, string) {
	s := strings.ToLower(strings.ReplaceAll(v, " ", ""))
	in, out := "allow", "allow"
	if strings.Contains(s, "blockinbound") {
		in = "block"
	}
	if strings.Contains(s, "blockoutbound") {
		out = "block"
	}
	if strings.Contains(s, "allowinbound") {
		in = "allow"
	}
	if strings.Contains(s, "allowoutbound") {
		out = "allow"
	}
	return in, out
}

func cutColon(line string) (string, string, bool) {
	i := strings.Index(line, ":")
	if i <= 0 {
		return "", "", false
	}
	return strings.TrimSpace(line[:i]), strings.TrimSpace(line[i+1:]), true
}

func emptyAny(v string) string {
	if v == "" || strings.EqualFold(v, "any") {
		return ""
	}
	return v
}

func netshProtocol(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "tcp":
		return "tcp"
	case "udp":
		return "udp"
	case "icmp", "icmpv4":
		return "icmp"
	default:
		return "any"
	}
}

func netshProfiles(v string) string {
	s := strings.ToLower(v)
	if s == "" || strings.Contains(s, "any") || (strings.Contains(s, "domain") && strings.Contains(s, "private") && strings.Contains(s, "public")) {
		return "all"
	}
	var parts []string
	if strings.Contains(s, "domain") {
		parts = append(parts, "domain")
	}
	if strings.Contains(s, "private") {
		parts = append(parts, "private")
	}
	if strings.Contains(s, "public") {
		parts = append(parts, "public")
	}
	if len(parts) == 0 {
		return "all"
	}
	return strings.Join(parts, ",")
}

func clipText(s string, max int) string {
	s = strings.TrimSpace(s)
	if max <= 0 || len(s) <= max {
		return s
	}
	return s[:max]
}

func unmarshalJSONList(raw string, dest any) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return errEmptyJSON
	}
	if i := strings.IndexAny(raw, "[{"); i > 0 {
		raw = strings.TrimSpace(raw[i:])
	}
	if strings.HasPrefix(raw, "{") {
		raw = "[" + raw + "]"
	}
	return json.Unmarshal([]byte(raw), dest)
}
