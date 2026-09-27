package winreg

import (
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

const (
	maxPath       = 1024
	maxSegment    = 255
	maxName       = 256
	maxList       = 500
	maxValueBytes = 8192
	AgentKeyPath  = `SOFTWARE\PC Manager\Agent`
)

var (
	ErrUnsupported  = errors.New("unsupported")
	ErrInvalidHive  = errors.New("invalid_hive")
	ErrInvalidPath  = errors.New("invalid_registry_path")
	ErrInvalidName  = errors.New("invalid_value_name")
	ErrInvalidType  = errors.New("invalid_value_type")
	ErrInvalidData  = errors.New("invalid_registry_data")
	ErrNotFound     = errors.New("registry_not_found")
	ErrAccessDenied = errors.New("registry_access_denied")
	ErrHiveRoot     = errors.New("cannot_modify_hive_root")
)

func IsDocumentedAgentKey(path string) bool {
	return strings.EqualFold(strings.TrimSpace(path), AgentKeyPath)
}

func missingAgentKeyResult(hive, path string, err error) *KeyResult {
	if err == nil || !IsDocumentedAgentKey(path) || !isNotFoundErr(err) {
		return nil
	}
	return &KeyResult{Hive: hive, Path: path, Keys: []string{}, Values: []Value{}}
}

func isNotFoundErr(err error) bool {
	return errors.Is(err, ErrNotFound)
}

func tolerateHiveRootValueEnum(path string, err error) bool {
	return err != nil && path == ""
}

type Value struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	Data      any    `json:"data,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

type KeyResult struct {
	Hive      string   `json:"hive"`
	Path      string   `json:"path"`
	Keys      []string `json:"keys"`
	Values    []Value  `json:"values"`
	Truncated bool     `json:"truncated"`
}

type WriteResult struct {
	Hive   string `json:"hive"`
	Path   string `json:"path"`
	Target string `json:"target"`
	Name   string `json:"name,omitempty"`
	Type   string `json:"type,omitempty"`
}

func NormalizeHive(hive string) (string, error) {
	switch strings.ToUpper(strings.TrimSpace(hive)) {
	case "HKLM", "HKEY_LOCAL_MACHINE":
		return "HKLM", nil
	case "HKCU", "HKEY_CURRENT_USER":
		return "HKCU", nil
	default:
		return "", ErrInvalidHive
	}
}

func NormalizePath(path string) (string, error) {
	path = strings.ReplaceAll(path, "/", `\`)
	var parts []string
	for _, p := range strings.Split(path, `\`) {
		p = strings.TrimSpace(p)
		if p == "" || p == "." {
			continue
		}
		if p == ".." || strings.ContainsAny(p, "\r\n\x00") || utf8.RuneCountInString(p) > maxSegment {
			return "", ErrInvalidPath
		}
		parts = append(parts, p)
	}
	joined := strings.Join(parts, `\`)
	if utf8.RuneCountInString(joined) > maxPath {
		return "", ErrInvalidPath
	}
	return joined, nil
}

func ValidateValueName(name string) (string, error) {
	if strings.ContainsAny(name, "\r\n\x00") || utf8.RuneCountInString(name) > maxName {
		return "", ErrInvalidName
	}
	return name, nil
}

type GetRequest struct {
	Hive string
	Path string
}

func ParseGet(raw json.RawMessage) (GetRequest, error) {
	var body struct {
		Hive string `json:"hive"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return GetRequest{}, ErrInvalidHive
	}
	hive, err := NormalizeHive(body.Hive)
	if err != nil {
		return GetRequest{}, err
	}
	path, err := NormalizePath(body.Path)
	if err != nil {
		return GetRequest{}, err
	}
	return GetRequest{Hive: hive, Path: path}, nil
}

type WriteRequest struct {
	Hive   string
	Path   string
	Target string
	Name   string
	Type   string
	Data   any
}

func ParseWrite(raw json.RawMessage) (WriteRequest, error) {
	var body struct {
		Hive   string `json:"hive"`
		Path   string `json:"path"`
		Target string `json:"target"`
		Name   string `json:"name"`
		Type   string `json:"type"`
		Data   any    `json:"data"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return WriteRequest{}, ErrInvalidHive
	}
	hive, err := NormalizeHive(body.Hive)
	if err != nil {
		return WriteRequest{}, err
	}
	path, err := NormalizePath(body.Path)
	if err != nil {
		return WriteRequest{}, err
	}
	target := strings.ToLower(strings.TrimSpace(body.Target))
	if target == "" {
		target = "value"
	}
	if target != "value" && target != "key" {
		return WriteRequest{}, ErrInvalidType
	}
	name, err := ValidateValueName(body.Name)
	if err != nil {
		return WriteRequest{}, err
	}
	typ := strings.ToUpper(strings.TrimSpace(body.Type))
	if target == "value" {
		if !validType(typ) {
			return WriteRequest{}, ErrInvalidType
		}
		if body.Data == nil {
			return WriteRequest{}, ErrInvalidData
		}
	}
	return WriteRequest{Hive: hive, Path: path, Target: target, Name: name, Type: typ, Data: body.Data}, nil
}

func ParseDelete(raw json.RawMessage) (WriteRequest, error) {
	var body struct {
		Hive   string `json:"hive"`
		Path   string `json:"path"`
		Target string `json:"target"`
		Name   string `json:"name"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return WriteRequest{}, ErrInvalidHive
	}
	hive, err := NormalizeHive(body.Hive)
	if err != nil {
		return WriteRequest{}, err
	}
	path, err := NormalizePath(body.Path)
	if err != nil {
		return WriteRequest{}, err
	}
	target := strings.ToLower(strings.TrimSpace(body.Target))
	if target == "" {
		target = "value"
	}
	if target != "value" && target != "key" {
		return WriteRequest{}, ErrInvalidType
	}
	name, err := ValidateValueName(body.Name)
	if err != nil {
		return WriteRequest{}, err
	}
	return WriteRequest{Hive: hive, Path: path, Target: target, Name: name}, nil
}

func validType(typ string) bool {
	switch typ {
	case "REG_SZ", "REG_EXPAND_SZ", "REG_DWORD", "REG_QWORD", "REG_MULTI_SZ", "REG_BINARY":
		return true
	default:
		return false
	}
}

func typeName(t uint32) string {
	switch t {
	case 1:
		return "REG_SZ"
	case 2:
		return "REG_EXPAND_SZ"
	case 3:
		return "REG_BINARY"
	case 4:
		return "REG_DWORD"
	case 5:
		return "REG_DWORD_BIG_ENDIAN"
	case 7:
		return "REG_MULTI_SZ"
	case 11:
		return "REG_QWORD"
	default:
		return "REG_NONE"
	}
}
