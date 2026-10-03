package inventory

import (
	"encoding/binary"
	"encoding/json"
	"net"
	"regexp"
	"strconv"
	"strings"
)

var secretPattern = regexp.MustCompile(`(?i)(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+`)
var oemSerial = regexp.MustCompile(`(?i)^(to be filled by o\.?e\.?m\.?|default string|none|not specified|system serial number|0+|n/a|unknown)$`)

func RedactConfig(value string) string {
	return secretPattern.ReplaceAllString(value, "$1=[redacted]")
}

func CleanSerial(value string) string {
	text := strings.TrimSpace(value)
	if text == "" || oemSerial.MatchString(text) {
		return ""
	}
	return clip(text, 128)
}

func ParseDpkg(text string) []Software {
	out := []Software{}
	for _, line := range strings.Split(text, "\n") {
		if len(out) >= 400 {
			break
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 2 || strings.TrimSpace(parts[0]) == "" {
			continue
		}
		publisher := ""
		if len(parts) > 2 {
			publisher = clip(parts[2], 256)
		}
		out = append(out, Software{
			Name: clip(parts[0], 256), Version: clip(parts[1], 128), Publisher: publisher, Source: "dpkg",
		})
	}
	return out
}

func ParseBrew(text string) []Software {
	out := []Software{}
	for _, line := range strings.Split(text, "\n") {
		if len(out) >= 400 {
			break
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		out = append(out, Software{Name: clip(fields[0], 256), Version: clip(fields[1], 128), Source: "brew"})
	}
	return out
}

func ParseSystemdShow(text string) []Service {
	out := []Service{}
	for _, block := range strings.Split(text, "\n\n") {
		if len(out) >= 300 {
			break
		}
		fields := map[string]string{}
		for _, line := range strings.Split(block, "\n") {
			key, val, ok := strings.Cut(line, "=")
			if ok {
				fields[key] = strings.TrimSpace(val)
			}
		}
		name := strings.TrimSuffix(fields["Id"], ".service")
		if name == "" {
			continue
		}
		exec := fields["ExecStart"]
		path := ""
		if idx := strings.Index(exec, "path="); idx >= 0 {
			rest := exec[idx+len("path="):]
			parts := strings.FieldsFunc(rest, func(r rune) bool { return r == ' ' || r == ';' })
			if len(parts) > 0 {
				path = parts[0]
			}
		}
		note := fields["DropInPaths"]
		if note == "" {
			note = fields["FragmentPath"]
		}
		out = append(out, Service{
			Name:        clip(name, 256),
			DisplayName: clip(fields["Description"], 256),
			State:       clip(fields["ActiveState"], 32),
			StartType:   clip(fields["UnitFileState"], 32),
			Account:     clip(fields["User"], 128),
			BinaryPath:  clip(RedactConfig(path), 1024),
			ConfigNote:  clip(RedactConfig(note), 512),
		})
	}
	return out
}

func ParseListen(text string) map[string][]string {
	out := map[string][]string{}
	nameRe := regexp.MustCompile(`\(\("([^"]+)"`)
	portRe := regexp.MustCompile(`:(\d+)\s`)
	for _, line := range strings.Split(text, "\n") {
		if !strings.Contains(line, "LISTEN") && !strings.Contains(strings.ToLower(line), "listen") {
			continue
		}
		name := ""
		if match := nameRe.FindStringSubmatch(line); len(match) > 1 {
			name = match[1]
		}
		port := ""
		if match := portRe.FindStringSubmatch(line); len(match) > 1 {
			port = match[1]
		}
		if name == "" || port == "" {
			continue
		}
		out[name] = append(out[name], port)
	}
	return out
}

func AttachListenPorts(services []Service, listens map[string][]string) {
	for i := range services {
		for proc, ports := range listens {
			if proc == services[i].Name || strings.HasPrefix(services[i].Name, proc) || strings.HasPrefix(proc, services[i].Name) {
				services[i].ListenPorts = clip(strings.Join(unique(ports), ","), 128)
			}
		}
	}
}

func unique(values []string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func ParseResolv(text string) (string, []string) {
	domain := ""
	dns := []string{}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "nameserver":
			if len(dns) < 8 {
				dns = append(dns, fields[1])
			}
		case "search", "domain":
			if domain == "" {
				domain = fields[1]
			}
		}
	}
	return domain, dns
}

func ParseRoute(text string) string {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[1] != "00000000" {
			continue
		}
		raw, err := strconv.ParseUint(fields[2], 16, 32)
		if err != nil || raw == 0 {
			continue
		}
		buf := make([]byte, 4)
		binary.LittleEndian.PutUint32(buf, uint32(raw))
		return net.IP(buf).String()
	}
	return ""
}

func ParseOsRelease(text string) (string, string) {
	values := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		values[key] = strings.Trim(val, `"`)
	}
	name := values["PRETTY_NAME"]
	if name == "" {
		name = values["NAME"]
	}
	return clip(name, 256), clip(values["VERSION_ID"], 128)
}

type lsblkReport struct {
	Blockdevices []struct {
		Name   string `json:"name"`
		Type   string `json:"type"`
		Size   uint64 `json:"size"`
		Model  string `json:"model"`
		Serial string `json:"serial"`
	} `json:"blockdevices"`
}

func ParseLsblk(text string) []Disk {
	var parsed lsblkReport
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return nil
	}
	out := []Disk{}
	for _, item := range parsed.Blockdevices {
		if item.Type != "" && item.Type != "disk" {
			continue
		}
		if len(out) >= 32 {
			break
		}
		out = append(out, Disk{Name: clip(item.Name, 128), Model: clip(item.Model, 256), Serial: CleanSerial(item.Serial), SizeBytes: item.Size})
	}
	return out
}

func ParseDMIMemory(text string) []Memory {
	out := []Memory{}
	var current *Memory
	flush := func() {
		if current == nil || current.SizeBytes == 0 {
			current = nil
			return
		}
		current.Serial = CleanSerial(current.Serial)
		out = append(out, *current)
		current = nil
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "Memory Device" {
			flush()
			current = &Memory{}
			continue
		}
		if current == nil {
			continue
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		switch key {
		case "Size":
			current.SizeBytes = parseSize(val)
		case "Locator":
			current.Bank = clip(val, 64)
		case "Speed":
			current.SpeedMhz = parseMhz(val)
		case "Manufacturer":
			current.Manufacturer = clip(val, 128)
		case "Serial Number":
			current.Serial = val
		}
	}
	flush()
	return out
}

func parseSize(value string) uint64 {
	fields := strings.Fields(value)
	if len(fields) < 2 {
		return 0
	}
	n, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0
	}
	switch strings.ToUpper(fields[1]) {
	case "GB":
		return uint64(n * 1024 * 1024 * 1024)
	case "MB":
		return uint64(n * 1024 * 1024)
	case "KB":
		return uint64(n * 1024)
	default:
		return 0
	}
}

func parseMhz(value string) int {
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return 0
	}
	n, err := strconv.Atoi(fields[0])
	if err != nil {
		return 0
	}
	return n
}

func RolesFromPorts(ports string) string {
	roles := []string{}
	set := map[string]string{"22": "ssh", "80": "http", "443": "https", "5432": "postgres", "3306": "mysql"}
	for _, port := range strings.Split(ports, ",") {
		if role, ok := set[strings.TrimSpace(port)]; ok {
			roles = append(roles, role)
		}
	}
	return strings.Join(unique(roles), ",")
}
