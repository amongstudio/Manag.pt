package winops

import "strings"

func parseDismCapabilities(raw string, query string) []WindowsCapability {
	query = strings.ToLower(strings.TrimSpace(query))
	var out []WindowsCapability
	var name string
	flush := func() {
		if name == "" {
			return
		}
		if query != "" && !strings.Contains(strings.ToLower(name), query) {
			name = ""
			return
		}
		out = append(out, WindowsCapability{Name: name, State: "unknown", Kind: capabilityKind(name)})
		name = ""
	}
	for _, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		trim := strings.TrimSpace(line)
		key, val, ok := cutKeyVal(trim)
		if !ok {
			continue
		}
		switch strings.ToLower(key) {
		case "capability identity", "capability name", "name", "identité de fonctionnalité", "identite de fonctionnalite":
			flush()
			name = strings.TrimSpace(val)
		case "state":
			if name == "" {
				continue
			}
			st := dismStateName(val)
			if query != "" && !strings.Contains(strings.ToLower(name), query) {
				name = ""
				continue
			}
			out = append(out, WindowsCapability{Name: name, State: st, Kind: capabilityKind(name)})
			name = ""
		}
	}
	flush()
	return out
}

func dismStateName(v string) string {
	switch strings.ToLower(strings.TrimSpace(strings.ReplaceAll(v, " ", "_"))) {
	case "not_present", "not present":
		return "not_present"
	case "uninstall_pending", "uninstall pending":
		return "uninstall_pending"
	case "staged":
		return "staged"
	case "resolved":
		return "resolved"
	case "removed":
		return "removed"
	case "installed":
		return "installed"
	case "permanent":
		return "permanent"
	case "superseded":
		return "superseded"
	case "partially_installed", "partially installed":
		return "partially_installed"
	default:
		s := strings.ToLower(strings.TrimSpace(v))
		if s == "" {
			return "unknown"
		}
		return strings.ReplaceAll(s, " ", "_")
	}
}
