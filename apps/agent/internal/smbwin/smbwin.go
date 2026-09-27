package smbwin

import (
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

const (
	maxShares   = 256
	maxList     = 500
	maxUNC      = 512
	maxUser     = 256
	maxPassword = 256
)

var (
	ErrUnsupported    = errors.New("unsupported")
	ErrInvalidPayload = errors.New("invalid_smb_payload")
	ErrAccessDenied   = errors.New("smb_access_denied")
	ErrNotFound       = errors.New("smb_not_found")
	ErrNotConnected   = errors.New("smb_not_connected")
)

type Share struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Remark    string `json:"remark,omitempty"`
	Drive     string `json:"drive,omitempty"`
	Remote    string `json:"remote,omitempty"`
	Connected bool   `json:"connected"`
	Hosted    bool   `json:"hosted,omitempty"`
	Status    string `json:"status,omitempty"`
	Username  string `json:"username,omitempty"`
}

type ShareList struct {
	Shares    []Share `json:"shares"`
	Truncated bool    `json:"truncated"`
}

type ListRequest struct {
	Path string
}

type ConnectRequest struct {
	UNC      string
	Username string
	Password string
	Persist  bool
	Drive    string
}

type ConnectResult struct {
	UNC       string `json:"unc"`
	Connected bool   `json:"connected"`
	Drive     string `json:"drive,omitempty"`
	Action    string `json:"action"`
}

type Entry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	Mode  string `json:"mode,omitempty"`
	Mtime string `json:"mtime,omitempty"`
}

type DirList struct {
	Path      string  `json:"path"`
	Entries   []Entry `json:"entries"`
	Truncated bool    `json:"truncated"`
}

func ParseList(raw json.RawMessage) (ListRequest, error) {
	var body struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return ListRequest{}, ErrInvalidPayload
	}
	p, err := NormalizeSharePath(body.Path)
	if err != nil {
		return ListRequest{}, err
	}
	return ListRequest{Path: p}, nil
}

func ParseConnect(raw json.RawMessage) (ConnectRequest, error) {
	var body struct {
		UNC      string `json:"unc"`
		Username string `json:"username"`
		Password string `json:"password"`
		Persist  bool   `json:"persist"`
		Drive    string `json:"drive"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return ConnectRequest{}, ErrInvalidPayload
	}
	unc, err := NormalizeUNC(body.UNC)
	if err != nil {
		return ConnectRequest{}, err
	}
	user := strings.TrimSpace(body.Username)
	if utf8.RuneCountInString(user) > maxUser || strings.ContainsAny(user, "\r\n\x00") {
		return ConnectRequest{}, ErrInvalidPayload
	}
	pass := body.Password
	if utf8.RuneCountInString(pass) > maxPassword || strings.ContainsAny(pass, "\r\n\x00") {
		return ConnectRequest{}, ErrInvalidPayload
	}
	drive := strings.ToUpper(strings.TrimSpace(body.Drive))
	drive = strings.TrimSuffix(drive, ":")
	if drive != "" && (len(drive) != 1 || drive[0] < 'A' || drive[0] > 'Z') {
		return ConnectRequest{}, ErrInvalidPayload
	}
	return ConnectRequest{UNC: unc, Username: user, Password: pass, Persist: body.Persist, Drive: drive}, nil
}

func ParseDisconnect(raw json.RawMessage) (string, error) {
	var body struct {
		UNC   string `json:"unc"`
		Path  string `json:"path"`
		Drive string `json:"drive"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return "", ErrInvalidPayload
	}
	if d := strings.ToUpper(strings.TrimSpace(strings.TrimSuffix(body.Drive, ":"))); len(d) == 1 && d[0] >= 'A' && d[0] <= 'Z' {
		return d + ":", nil
	}
	p := body.UNC
	if p == "" {
		p = body.Path
	}
	if strings.TrimSpace(p) == "" {
		return "", ErrInvalidPayload
	}
	return NormalizeSharePath(p)
}

func NormalizeUNC(p string) (string, error) {
	s := strings.TrimSpace(strings.ReplaceAll(p, "/", `\`))
	if s == "" || utf8.RuneCountInString(s) > maxUNC || strings.ContainsAny(s, "\r\n\x00") {
		return "", ErrInvalidPayload
	}
	if hasDotDotSegment(s) {
		return "", ErrInvalidPayload
	}
	if !strings.HasPrefix(s, `\\`) {
		return "", ErrInvalidPayload
	}
	trim := strings.TrimRight(s, `\`)
	parts := strings.Split(strings.TrimPrefix(trim, `\\`), `\`)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", ErrInvalidPayload
	}
	return trim, nil
}

func NormalizeSharePath(p string) (string, error) {
	s := strings.TrimSpace(strings.ReplaceAll(p, "/", `\`))
	if s == "" {
		return "", ErrInvalidPayload
	}
	if utf8.RuneCountInString(s) > maxUNC || strings.ContainsAny(s, "\r\n\x00") || hasDotDotSegment(s) {
		return "", ErrInvalidPayload
	}
	if strings.HasPrefix(s, `\\`) {
		return NormalizeUNC(s)
	}
	if !IsDrivePath(s) {
		return "", ErrInvalidPayload
	}
	letter := strings.ToUpper(s[:1])
	rest := strings.TrimLeft(s[2:], `\`)
	if rest == "" || rest == "." {
		return letter + `:\`, nil
	}
	return letter + `:\` + rest, nil
}

func IsRemotePath(p string) bool {
	s := strings.TrimSpace(p)
	return strings.HasPrefix(s, `\\`) || strings.HasPrefix(s, `//`)
}

func IsDrivePath(p string) bool {
	s := strings.TrimSpace(strings.ReplaceAll(p, "/", `\`))
	if len(s) < 2 || s[1] != ':' {
		return false
	}
	c := s[0]
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
}

func JoinSharePath(base, name string) string {
	b := strings.TrimRight(strings.ReplaceAll(strings.TrimSpace(base), "/", `\`), `\`)
	n := strings.Trim(strings.ReplaceAll(name, "/", `\`), `\`)
	if n == "" {
		return b
	}
	if hasDotDotSegment(n) || strings.ContainsAny(n, "\x00\r\n") {
		return b
	}
	return b + `\` + n
}

func PathAllowed(path string, known []Share) bool {
	clean, err := NormalizeSharePath(path)
	if err != nil {
		return false
	}
	if IsRemotePath(clean) {
		return true
	}
	if remoteDrive(clean) {
		return true
	}
	fold := strings.ToLower(strings.TrimRight(clean, `\`))
	for _, s := range known {
		roots := []string{s.Path, s.Drive}
		for _, root := range roots {
			r := strings.ToLower(strings.TrimRight(strings.ReplaceAll(root, "/", `\`), `\`))
			if r == "" || strings.HasPrefix(r, `\\`) {
				continue
			}
			if fold == r || strings.HasPrefix(fold, r+`\`) {
				return true
			}
		}
	}
	return false
}

func ResolveFilePath(path string, known []Share) (string, error) {
	clean, err := NormalizeSharePath(path)
	if err != nil {
		return "", err
	}
	if !PathAllowed(clean, known) {
		return "", ErrNotConnected
	}
	return clean, nil
}

func hasDotDotSegment(p string) bool {
	normalized := strings.ReplaceAll(p, `\`, "/")
	for _, seg := range strings.Split(normalized, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// MapError turns OS/SMB I/O failures into smb_access_denied / smb_not_found when possible.
func MapError(err error) error {
	return mapOSError(err)
}

// DosDeviceToUNC turns QueryDosDevice / Mup / LanmanRedirector strings into \\server\share.
func DosDeviceToUNC(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if i := strings.IndexByte(s, 0); i >= 0 {
		s = s[:i]
	}
	s = strings.ReplaceAll(s, "/", `\`)
	lower := strings.ToLower(s)
	for _, prefix := range []string{`\??\unc\`, `\device\mup\`, `\device\lanmanredirector\`} {
		if strings.HasPrefix(lower, prefix) {
			s = s[len(prefix):]
			break
		}
	}
	for {
		s = strings.TrimLeft(s, `\`)
		if !strings.HasPrefix(s, `;`) {
			break
		}
		rest := s[1:]
		if j := strings.Index(rest, `\`); j >= 0 {
			s = rest[j+1:]
			continue
		}
		s = rest
		break
	}
	s = strings.Trim(s, `\`)
	if s == "" || !strings.Contains(s, `\`) {
		return ""
	}
	if strings.HasPrefix(s, `\\`) {
		return s
	}
	return `\\` + s
}
