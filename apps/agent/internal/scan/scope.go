package scan

import (
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type Scope struct {
	AuthorizedNetworks []string `yaml:"authorized_networks"`
	ExcludedHosts      []string `yaml:"excluded_hosts"`
	ScanRateLimit      int      `yaml:"scan_rate_limit"`
	ScanTimeoutMinutes int      `yaml:"scan_timeout_minutes"`
	LabMode            *bool    `yaml:"lab_mode"`
	LabNetworks        []string `yaml:"lab_networks"`
	EnableVulners      bool     `yaml:"enable_vulners"`
}

func DefaultScope() Scope {
	return Scope{
		AuthorizedNetworks: []string{"127.0.0.1/32"},
		ScanRateLimit:      100,
		ScanTimeoutMinutes: 10,
		LabMode:            boolPtr(true),
	}
}

func boolPtr(v bool) *bool { return &v }

func (s Scope) lab() bool {
	if s.LabMode == nil {
		return true
	}
	return *s.LabMode
}

func LoadScope(path string) Scope {
	raw, err := os.ReadFile(path)
	if err != nil {
		return DefaultScope()
	}
	var parsed Scope
	if err := yaml.Unmarshal(raw, &parsed); err != nil {
		return DefaultScope()
	}
	if parsed.ScanRateLimit <= 0 {
		parsed.ScanRateLimit = 100
	}
	if parsed.ScanRateLimit > 10000 {
		parsed.ScanRateLimit = 10000
	}
	if parsed.ScanTimeoutMinutes <= 0 {
		parsed.ScanTimeoutMinutes = 10
	}
	if parsed.LabMode == nil {
		parsed.LabMode = boolPtr(true)
	}
	return parsed
}

type Decision struct {
	OK     bool
	Target string
	Error  string
}

func AuthorizeTarget(target string, scope Scope) Decision {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" || strings.ContainsAny(trimmed, " \t\"'`$;&|<>\\") {
		return Decision{Error: "target_refused"}
	}
	if trimmed == "::1" || trimmed == "[::1]" {
		if !scope.lab() {
			return Decision{Error: "target_refused"}
		}
		return Decision{OK: true, Target: "::1"}
	}
	net, ok := parseNet(trimmed)
	if !ok {
		return Decision{Error: "target_refused"}
	}
	for _, host := range scope.ExcludedHosts {
		exc, ok := parseNet(host)
		if ok && exc.bits == 32 && contains(net, exc.base) {
			return Decision{Error: "target_excluded"}
		}
	}
	var allowed []ipNet
	if scope.lab() {
		if loop, ok := parseNet("127.0.0.1/32"); ok {
			allowed = append(allowed, loop)
		}
		for _, item := range scope.LabNetworks {
			if n, ok := parseNet(item); ok {
				allowed = append(allowed, n)
			}
		}
	} else {
		for _, item := range scope.AuthorizedNetworks {
			if n, ok := parseNet(item); ok {
				allowed = append(allowed, n)
			}
		}
	}
	for _, network := range allowed {
		if within(net, network) {
			return Decision{OK: true, Target: trimmed}
		}
	}
	return Decision{Error: "target_refused"}
}

type ipNet struct {
	base uint32
	bits int
}

func parseNet(token string) (ipNet, bool) {
	token = strings.TrimSpace(token)
	addr := token
	bits := 32
	if i := strings.IndexByte(token, '/'); i >= 0 {
		addr = token[:i]
		n, err := strconv.Atoi(token[i+1:])
		if err != nil || n < 0 || n > 32 {
			return ipNet{}, false
		}
		bits = n
	}
	ip, ok := parseIPv4(addr)
	if !ok {
		return ipNet{}, false
	}
	mask := uint32(0)
	if bits > 0 {
		mask = ^uint32(0) << (32 - bits)
	}
	return ipNet{base: ip & mask, bits: bits}, true
}

func parseIPv4(ip string) (uint32, bool) {
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return 0, false
	}
	var value uint32
	for _, part := range parts {
		if part == "" || len(part) > 3 {
			return 0, false
		}
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 || n > 255 {
			return 0, false
		}
		value = (value << 8) | uint32(n)
	}
	return value, true
}

func contains(network ipNet, ip uint32) bool {
	if network.bits == 0 {
		return true
	}
	mask := ^uint32(0) << (32 - network.bits)
	return ip&mask == network.base
}

func within(inner, outer ipNet) bool {
	if inner.bits < outer.bits {
		return false
	}
	return contains(outer, inner.base)
}
