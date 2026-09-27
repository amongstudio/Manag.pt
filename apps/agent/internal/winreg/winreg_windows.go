//go:build windows

package winreg

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func Get(raw json.RawMessage) (*KeyResult, error) {
	req, err := ParseGet(raw)
	if err != nil {
		return nil, err
	}
	k, closer, err := open(req.Hive, req.Path, registry.READ)
	if err != nil {
		mapped := mapRegErr(err)
		if res := missingAgentKeyResult(req.Hive, req.Path, mapped); res != nil {
			return res, nil
		}
		return nil, mapped
	}
	defer closer()

	keyNames, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return nil, mapRegErr(err)
	}
	valueNames, err := k.ReadValueNames(-1)
	if err != nil {
		if !tolerateHiveRootValueEnum(req.Path, err) {
			return nil, mapRegErr(err)
		}
		valueNames = nil
	}
	sort.Strings(keyNames)
	sort.Strings(valueNames)

	truncated := false
	if keyNames == nil {
		keyNames = []string{}
	}
	if valueNames == nil {
		valueNames = []string{}
	}
	if len(keyNames) > maxList {
		keyNames = keyNames[:maxList]
		truncated = true
	}
	if len(valueNames) > maxList {
		valueNames = valueNames[:maxList]
		truncated = true
	}
	values := make([]Value, 0, len(valueNames))
	for _, name := range valueNames {
		values = append(values, readValue(k, name))
	}
	return &KeyResult{
		Hive:      req.Hive,
		Path:      req.Path,
		Keys:      keyNames,
		Values:    values,
		Truncated: truncated,
	}, nil
}

func Set(raw json.RawMessage) (*WriteResult, error) {
	req, err := ParseWrite(raw)
	if err != nil {
		return nil, err
	}
	if req.Target == "key" {
		if req.Path == "" {
			return nil, ErrHiveRoot
		}
		_, closer, err := create(req.Hive, req.Path, registry.WRITE)
		if err != nil {
			return nil, mapRegErr(err)
		}
		closer()
		return &WriteResult{Hive: req.Hive, Path: req.Path, Target: "key"}, nil
	}
	k, closer, err := create(req.Hive, req.Path, registry.SET_VALUE|registry.READ)
	if err != nil {
		return nil, mapRegErr(err)
	}
	defer closer()
	if err := writeValue(k, req); err != nil {
		return nil, err
	}
	return &WriteResult{Hive: req.Hive, Path: req.Path, Target: "value", Name: req.Name, Type: req.Type}, nil
}

func Delete(raw json.RawMessage) (*WriteResult, error) {
	req, err := ParseDelete(raw)
	if err != nil {
		return nil, err
	}
	if req.Target == "key" {
		if req.Path == "" {
			return nil, ErrHiveRoot
		}
		parentPath, leaf := splitLast(req.Path)
		parent, closer, err := open(req.Hive, parentPath, registry.WRITE)
		if err != nil {
			return nil, mapRegErr(err)
		}
		defer closer()
		if err := registry.DeleteKey(parent, leaf); err != nil {
			return nil, mapRegErr(err)
		}
		return &WriteResult{Hive: req.Hive, Path: req.Path, Target: "key"}, nil
	}
	k, closer, err := open(req.Hive, req.Path, registry.SET_VALUE)
	if err != nil {
		return nil, mapRegErr(err)
	}
	defer closer()
	if err := k.DeleteValue(req.Name); err != nil {
		return nil, mapRegErr(err)
	}
	return &WriteResult{Hive: req.Hive, Path: req.Path, Target: "value", Name: req.Name}, nil
}

func hiveKey(hive string) registry.Key {
	if hive == "HKCU" {
		return registry.CURRENT_USER
	}
	return registry.LOCAL_MACHINE
}

func open(hive, path string, access uint32) (registry.Key, func(), error) {
	root := hiveKey(hive)
	if path == "" {
		return root, func() {}, nil
	}
	k, err := registry.OpenKey(root, path, access|registry.WOW64_64KEY)
	if err != nil && isRawNotFound(err) {
		k, err = registry.OpenKey(root, path, access|registry.WOW64_32KEY)
	}
	if err != nil {
		return 0, func() {}, err
	}
	return k, func() { _ = k.Close() }, nil
}

func create(hive, path string, access uint32) (registry.Key, func(), error) {
	root := hiveKey(hive)
	if path == "" {
		return root, func() {}, nil
	}
	k, _, err := registry.CreateKey(root, path, access|registry.WOW64_64KEY)
	if err != nil {
		return 0, func() {}, err
	}
	return k, func() { _ = k.Close() }, nil
}

func splitLast(path string) (string, string) {
	i := strings.LastIndex(path, `\`)
	if i < 0 {
		return "", path
	}
	return path[:i], path[i+1:]
}

func readValue(k registry.Key, name string) Value {
	n, typ, err := k.GetValue(name, nil)
	if err != nil && !errors.Is(err, registry.ErrShortBuffer) {
		return Value{Name: name, Type: "REG_NONE"}
	}
	truncated := n > maxValueBytes
	size := n
	if size > maxValueBytes {
		size = maxValueBytes
	}
	buf := make([]byte, size)
	got, typ, err := k.GetValue(name, buf)
	if err != nil && !errors.Is(err, registry.ErrShortBuffer) {
		return Value{Name: name, Type: typeName(typ), Truncated: truncated}
	}
	if got < len(buf) {
		buf = buf[:got]
	}
	v := Value{Name: name, Type: typeName(typ), Truncated: truncated}
	v.Data = decodeData(typ, buf, truncated)
	return v
}

func decodeData(typ uint32, buf []byte, truncated bool) any {
	switch typ {
	case registry.SZ, registry.EXPAND_SZ:
		if len(buf) == 0 {
			return ""
		}
		u := utf16.Decode(bytesToUint16(buf))
		s := string(u)
		s = strings.TrimRight(s, "\x00")
		return s
	case registry.MULTI_SZ:
		if truncated {
			return base64.StdEncoding.EncodeToString(buf)
		}
		return splitMultiSZ(buf)
	case registry.DWORD:
		if len(buf) >= 4 {
			return binary.LittleEndian.Uint32(buf[:4])
		}
		return uint32(0)
	case registry.QWORD:
		if len(buf) >= 8 {
			return strconv.FormatUint(binary.LittleEndian.Uint64(buf[:8]), 10)
		}
		return "0"
	default:
		return base64.StdEncoding.EncodeToString(buf)
	}
}

func bytesToUint16(b []byte) []uint16 {
	n := len(b) / 2
	out := make([]uint16, n)
	for i := 0; i < n; i++ {
		out[i] = binary.LittleEndian.Uint16(b[i*2:])
	}
	return out
}

func splitMultiSZ(buf []byte) []string {
	u := bytesToUint16(buf)
	if len(u) > 0 && u[len(u)-1] == 0 {
		u = u[:len(u)-1]
	}
	var out []string
	from := 0
	for i, c := range u {
		if c == 0 {
			out = append(out, string(utf16.Decode(u[from:i])))
			from = i + 1
		}
	}
	if from < len(u) {
		out = append(out, string(utf16.Decode(u[from:])))
	}
	return out
}

func writeValue(k registry.Key, req WriteRequest) error {
	switch req.Type {
	case "REG_SZ":
		s, err := asString(req.Data)
		if err != nil {
			return err
		}
		return k.SetStringValue(req.Name, s)
	case "REG_EXPAND_SZ":
		s, err := asString(req.Data)
		if err != nil {
			return err
		}
		return k.SetExpandStringValue(req.Name, s)
	case "REG_DWORD":
		n, err := asUint64(req.Data)
		if err != nil || n > math.MaxUint32 {
			return ErrInvalidData
		}
		return k.SetDWordValue(req.Name, uint32(n))
	case "REG_QWORD":
		n, err := asUint64(req.Data)
		if err != nil {
			return err
		}
		return k.SetQWordValue(req.Name, n)
	case "REG_MULTI_SZ":
		ss, err := asStrings(req.Data)
		if err != nil {
			return err
		}
		return k.SetStringsValue(req.Name, ss)
	case "REG_BINARY":
		b, err := asBytes(req.Data)
		if err != nil {
			return err
		}
		return k.SetBinaryValue(req.Name, b)
	default:
		return ErrInvalidType
	}
}

func asString(v any) (string, error) {
	switch s := v.(type) {
	case string:
		return s, nil
	case float64:
		return strconv.FormatFloat(s, 'f', -1, 64), nil
	default:
		return "", ErrInvalidData
	}
}

func asUint64(v any) (uint64, error) {
	switch n := v.(type) {
	case float64:
		if n < 0 || n > math.MaxUint64 || math.Trunc(n) != n {
			return 0, ErrInvalidData
		}
		return uint64(n), nil
	case json.Number:
		return strconv.ParseUint(string(n), 0, 64)
	case string:
		return strconv.ParseUint(strings.TrimSpace(n), 0, 64)
	default:
		return 0, ErrInvalidData
	}
}

func asStrings(v any) ([]string, error) {
	switch s := v.(type) {
	case []any:
		out := make([]string, 0, len(s))
		for _, item := range s {
			str, err := asString(item)
			if err != nil {
				return nil, err
			}
			out = append(out, str)
		}
		return out, nil
	case []string:
		return s, nil
	case string:
		if s == "" {
			return []string{}, nil
		}
		return strings.Split(s, "\n"), nil
	default:
		return nil, ErrInvalidData
	}
}

func asBytes(v any) ([]byte, error) {
	s, err := asString(v)
	if err != nil {
		return nil, err
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return []byte{}, nil
	}
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	hex := strings.ReplaceAll(strings.ReplaceAll(s, " ", ""), "-", "")
	if len(hex)%2 != 0 {
		return nil, ErrInvalidData
	}
	out := make([]byte, len(hex)/2)
	for i := 0; i < len(out); i++ {
		n, err := strconv.ParseUint(hex[i*2:i*2+2], 16, 8)
		if err != nil {
			return nil, ErrInvalidData
		}
		out[i] = byte(n)
	}
	return out, nil
}

func mapRegErr(err error) error {
	if err == nil {
		return nil
	}
	if isRawNotFound(err) {
		return ErrNotFound
	}
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return ErrAccessDenied
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "access is denied") || strings.Contains(msg, "access_denied") {
		return ErrAccessDenied
	}
	return err
}

func isRawNotFound(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, registry.ErrNotExist) {
		return true
	}
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		return true
	}
	return false
}
