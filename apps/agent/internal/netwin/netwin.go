package netwin

import (
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

const (
	OfficialPort   = 17891
	maxName        = 256
	maxText        = 1024
	maxAddr        = 512
	maxPorts       = 256
	maxAdapters    = 128
	maxPortRows    = 2000
	maxFirewall    = 1500
	maxDescription = 1024
	maxFirewallJSON = 220 * 1024
)

var (
	ErrUnsupported     = errors.New("unsupported")
	ErrInvalidName     = errors.New("invalid_firewall_name")
	ErrInvalidPayload  = errors.New("invalid_network_payload")
	ErrInvalidProtocol = errors.New("invalid_firewall_protocol")
	ErrInvalidRule     = errors.New("invalid_firewall_rule")
	ErrNotFound        = errors.New("firewall_rule_not_found")
	ErrAccessDenied    = errors.New("firewall_access_denied")
	ErrEnumFailed      = errors.New("network_enum_failed")
)

var errEnumDone = errors.New("enum_done")

type Adapter struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	ID          string   `json:"id,omitempty"`
	Status      string   `json:"status"`
	IfType      string   `json:"ifType,omitempty"`
	MAC         string   `json:"mac,omitempty"`
	MTU         uint32   `json:"mtu,omitempty"`
	DHCP        bool     `json:"dhcp,omitempty"`
	DHCPServer  string   `json:"dhcpServer,omitempty"`
	IPv4        []string `json:"ipv4,omitempty"`
	IPv6        []string `json:"ipv6,omitempty"`
	DNS         []string `json:"dns,omitempty"`
	Gateways    []string `json:"gateways,omitempty"`
	DNSSuffix   string   `json:"dnsSuffix,omitempty"`
	Index       uint32   `json:"index,omitempty"`
}

type AdapterList struct {
	Adapters  []Adapter `json:"adapters"`
	Truncated bool      `json:"truncated"`
}

type Port struct {
	Protocol   string `json:"protocol"`
	LocalAddr  string `json:"localAddr"`
	LocalPort  uint16 `json:"localPort"`
	RemoteAddr string `json:"remoteAddr,omitempty"`
	RemotePort uint16 `json:"remotePort,omitempty"`
	State      string `json:"state"`
	PID        uint32 `json:"pid,omitempty"`
	Process    string `json:"process,omitempty"`
	Official   bool   `json:"official,omitempty"`
}

type PortList struct {
	Ports     []Port `json:"ports"`
	Truncated bool   `json:"truncated"`
}

type FirewallProfile struct {
	Name            string `json:"name"`
	Enabled         bool   `json:"enabled"`
	DefaultInbound  string `json:"defaultInbound,omitempty"`
	DefaultOutbound string `json:"defaultOutbound,omitempty"`
}

type FirewallRule struct {
	Name            string `json:"name"`
	Description     string `json:"description,omitempty"`
	Direction       string `json:"direction"`
	Action          string `json:"action"`
	Enabled         bool   `json:"enabled"`
	Protocol        string `json:"protocol,omitempty"`
	LocalPorts      string `json:"localPorts,omitempty"`
	RemotePorts     string `json:"remotePorts,omitempty"`
	LocalAddresses  string `json:"localAddresses,omitempty"`
	RemoteAddresses string `json:"remoteAddresses,omitempty"`
	Application     string `json:"application,omitempty"`
	ServiceName     string `json:"serviceName,omitempty"`
	Profiles        string `json:"profiles,omitempty"`
	Grouping        string `json:"grouping,omitempty"`
}

type FirewallResult struct {
	Profiles    []FirewallProfile `json:"profiles"`
	Rules       []FirewallRule    `json:"rules"`
	Truncated   bool              `json:"truncated"`
	ModifyState string            `json:"modifyState,omitempty"`
}

type WriteResult struct {
	Name   string `json:"name"`
	Action string `json:"action"`
}

type PortsRequest struct {
	ListenOnly bool
}

func ParsePorts(raw json.RawMessage) (PortsRequest, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return PortsRequest{}, nil
	}
	var body struct {
		ListenOnly bool `json:"listenOnly"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return PortsRequest{}, ErrInvalidPayload
	}
	return PortsRequest{ListenOnly: body.ListenOnly}, nil
}

type RuleRequest struct {
	Name            string
	Description     string
	Direction       string
	Action          string
	Enabled         *bool
	Protocol        string
	LocalPorts      string
	RemotePorts     string
	LocalAddresses  string
	RemoteAddresses string
	Application     string
	ServiceName     string
	Grouping        string
	Profiles        string
	HasDescription  bool
	HasDirection    bool
	HasAction       bool
	HasProtocol     bool
	HasLocalPorts   bool
	HasRemotePorts  bool
	HasLocalAddr    bool
	HasRemoteAddr   bool
	HasApplication  bool
	HasServiceName  bool
	HasGrouping     bool
	HasProfiles     bool
}

func ParseRule(raw json.RawMessage) (RuleRequest, error) {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil {
		return RuleRequest{}, ErrInvalidPayload
	}
	name, err := decodeString(body["name"])
	if err != nil {
		return RuleRequest{}, err
	}
	name, err = ValidateName(name)
	if err != nil {
		return RuleRequest{}, err
	}
	req := RuleRequest{Name: name}
	if v, ok := body["description"]; ok {
		s, err := optionalText(v, maxDescription)
		if err != nil {
			return RuleRequest{}, err
		}
		req.Description = s
		req.HasDescription = true
	}
	if v, ok := body["direction"]; ok {
		s, err := decodeString(v)
		if err != nil {
			return RuleRequest{}, err
		}
		d, err := normalizeDirection(s)
		if err != nil {
			return RuleRequest{}, err
		}
		req.Direction = d
		req.HasDirection = true
	}
	if v, ok := body["action"]; ok {
		s, err := decodeString(v)
		if err != nil {
			return RuleRequest{}, err
		}
		a, err := normalizeAction(s)
		if err != nil {
			return RuleRequest{}, err
		}
		req.Action = a
		req.HasAction = true
	}
	if v, ok := body["enabled"]; ok {
		b, err := decodeBool(v)
		if err != nil {
			return RuleRequest{}, err
		}
		req.Enabled = &b
	}
	if v, ok := body["protocol"]; ok {
		s, err := decodeString(v)
		if err != nil {
			return RuleRequest{}, err
		}
		p, err := normalizeProtocol(s)
		if err != nil {
			return RuleRequest{}, err
		}
		req.Protocol = p
		req.HasProtocol = true
	}
	if v, ok := body["localPorts"]; ok {
		s, err := optionalText(v, maxPorts)
		if err != nil {
			return RuleRequest{}, err
		}
		req.LocalPorts = s
		req.HasLocalPorts = true
	}
	if v, ok := body["remotePorts"]; ok {
		s, err := optionalText(v, maxPorts)
		if err != nil {
			return RuleRequest{}, err
		}
		req.RemotePorts = s
		req.HasRemotePorts = true
	}
	if v, ok := body["localAddresses"]; ok {
		s, err := optionalText(v, maxAddr)
		if err != nil {
			return RuleRequest{}, err
		}
		req.LocalAddresses = s
		req.HasLocalAddr = true
	}
	if v, ok := body["remoteAddresses"]; ok {
		s, err := optionalText(v, maxAddr)
		if err != nil {
			return RuleRequest{}, err
		}
		req.RemoteAddresses = s
		req.HasRemoteAddr = true
	}
	if v, ok := body["application"]; ok {
		s, err := optionalText(v, maxText)
		if err != nil {
			return RuleRequest{}, err
		}
		req.Application = s
		req.HasApplication = true
	}
	if v, ok := body["serviceName"]; ok {
		s, err := optionalText(v, maxName)
		if err != nil {
			return RuleRequest{}, err
		}
		req.ServiceName = s
		req.HasServiceName = true
	}
	if v, ok := body["grouping"]; ok {
		s, err := optionalText(v, maxName)
		if err != nil {
			return RuleRequest{}, err
		}
		req.Grouping = s
		req.HasGrouping = true
	}
	if v, ok := body["profiles"]; ok {
		s, err := optionalText(v, 64)
		if err != nil {
			return RuleRequest{}, err
		}
		p, err := normalizeProfiles(s)
		if err != nil {
			return RuleRequest{}, err
		}
		req.Profiles = p
		req.HasProfiles = true
	}
	return req, nil
}

func ParseDelete(raw json.RawMessage) (string, error) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return "", ErrInvalidName
	}
	return ValidateName(body.Name)
}

func ValidateName(name string) (string, error) {
	n := strings.TrimSpace(name)
	if n == "" || utf8.RuneCountInString(n) > maxName {
		return "", ErrInvalidName
	}
	if strings.ContainsAny(n, "\r\n\x00") {
		return "", ErrInvalidName
	}
	return n, nil
}

func markOfficial(p *Port) {
	if p != nil && p.LocalPort == OfficialPort {
		p.Official = true
	}
}

func decodeString(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", ErrInvalidPayload
	}
	return s, nil
}

func decodeBool(raw json.RawMessage) (bool, error) {
	var b bool
	if err := json.Unmarshal(raw, &b); err != nil {
		return false, ErrInvalidPayload
	}
	return b, nil
}

func optionalText(raw json.RawMessage, max int) (string, error) {
	s, err := decodeString(raw)
	if err != nil {
		return "", err
	}
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > max || strings.ContainsAny(s, "\r\n\x00") {
		return "", ErrInvalidRule
	}
	return s, nil
}

func fitFirewall(out *FirewallResult) {
	if out == nil {
		return
	}
	if out.Rules == nil {
		out.Rules = []FirewallRule{}
	}
	for i := range out.Rules {
		if len(out.Rules[i].Description) > 160 {
			out.Rules[i].Description = out.Rules[i].Description[:160]
		}
	}
	for {
		raw, err := json.Marshal(out)
		if err != nil || len(raw) <= maxFirewallJSON || len(out.Rules) == 0 {
			return
		}
		n := len(out.Rules) * 9 / 10
		if n >= len(out.Rules) {
			n = len(out.Rules) - 1
		}
		if n < 0 {
			n = 0
		}
		out.Rules = out.Rules[:n]
		out.Truncated = true
	}
}

func normalizeDirection(v string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "inbound", "in":
		return "inbound", nil
	case "outbound", "out":
		return "outbound", nil
	default:
		return "", ErrInvalidRule
	}
}

func normalizeAction(v string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "allow":
		return "allow", nil
	case "block":
		return "block", nil
	default:
		return "", ErrInvalidRule
	}
}

func normalizeProtocol(v string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "any":
		return "any", nil
	case "tcp":
		return "tcp", nil
	case "udp":
		return "udp", nil
	case "icmp":
		return "icmp", nil
	default:
		return "", ErrInvalidProtocol
	}
}

func normalizeProfiles(v string) (string, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return "all", nil
	}
	parts := strings.Split(v, ",")
	seen := map[string]bool{}
	var out []string
	for _, p := range parts {
		p = strings.ToLower(strings.TrimSpace(p))
		if p == "" {
			continue
		}
		switch p {
		case "all":
			return "all", nil
		case "domain", "private", "public":
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		default:
			return "", ErrInvalidRule
		}
	}
	if len(out) == 0 {
		return "all", nil
	}
	return strings.Join(out, ","), nil
}
