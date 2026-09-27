package svcctl

import (
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

const (
	AgentServiceName  = "PCManagerAgent"
	HelperServiceName = "PCManagerHelper"
	maxName           = 256
	maxList           = 2000
)

var (
	ErrUnsupported  = errors.New("unsupported")
	ErrInvalidName  = errors.New("invalid_service_name")
	ErrNotFound     = errors.New("service_not_found")
	ErrTimeout      = errors.New("service_timeout")
	ErrAccessDenied = errors.New("scm_access_denied")
	ErrEnumFailed   = errors.New("scm_enum_failed")
)

type Info struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
	Status      string `json:"status"`
	StartType   string `json:"startType,omitempty"`
	PID         uint32 `json:"pid,omitempty"`
	Official    bool   `json:"official,omitempty"`
}

type ListResult struct {
	Services  []Info `json:"services"`
	Truncated bool   `json:"truncated"`
}

type ControlResult struct {
	Name      string `json:"name"`
	Action    string `json:"action"`
	Status    string `json:"status,omitempty"`
	StartType string `json:"startType,omitempty"`
	PID       uint32 `json:"pid,omitempty"`
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

func ParseName(raw json.RawMessage) (string, error) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return "", ErrInvalidName
	}
	return ValidateName(body.Name)
}

func IsAgentService(name string) bool {
	return strings.EqualFold(strings.TrimSpace(name), AgentServiceName)
}

func IsHelperService(name string) bool {
	return strings.EqualFold(strings.TrimSpace(name), HelperServiceName)
}

func IsOfficial(name string) bool {
	return IsAgentService(name) || IsHelperService(name)
}
