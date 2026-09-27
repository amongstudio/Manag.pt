package credwin

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxCreds    = 400
	maxTarget   = 256
	maxUser     = 256
	maxSecret   = 2048
	maxComment  = 256
	charset     = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*"
)

var (
	ErrUnsupported    = errors.New("unsupported")
	ErrInvalidPayload = errors.New("invalid_credential_payload")
	ErrAccessDenied   = errors.New("credential_access_denied")
	ErrNotFound       = errors.New("credential_not_found")
	ErrNoSession      = errors.New("no_interactive_session")
)

type Credential struct {
	Key         string `json:"key"`
	Source      string `json:"source"`
	Kind        string `json:"kind"`
	Target      string `json:"target"`
	Username    string `json:"username,omitempty"`
	Secret      string `json:"secret,omitempty"`
	Persist     string `json:"persist,omitempty"`
	Comment     string `json:"comment,omitempty"`
	LastWritten string `json:"lastWritten,omitempty"`
	Browser     string `json:"browser,omitempty"`
	Profile     string `json:"profile,omitempty"`
	Locked      bool   `json:"locked,omitempty"`
	Store       string `json:"store,omitempty"`
}

type CredentialCounts struct {
	Windows   int `json:"windows"`
	Browser   int `json:"browser"`
	Apps      int `json:"apps"`
	Generated int `json:"generated"`
	Locked    int `json:"locked"`
	Total     int `json:"total"`
}

type ListResult struct {
	Credentials     []Credential     `json:"credentials"`
	Truncated       bool             `json:"truncated"`
	Revealed        bool             `json:"revealed"`
	SessionOk       bool             `json:"sessionOk"`
	NeedsSession    bool             `json:"needsSession"`
	BrowserLocked   bool             `json:"browserLocked"`
	Session0        bool             `json:"session0"`
	SessionID       uint32           `json:"sessionId,omitempty"`
	SessionUser     string           `json:"sessionUser,omitempty"`
	SessionState    string           `json:"sessionState,omitempty"`
	ImpersonationOk bool             `json:"impersonationOk"`
	Counts          CredentialCounts `json:"counts"`
	Notes           []string         `json:"notes,omitempty"`
}

type ListRequest struct {
	Sources []string
	Reveal  bool
}

type WriteRequest struct {
	Source   string
	Target   string
	Username string
	Secret   string
	Persist  string
	Comment  string
}

type DeleteRequest struct {
	Source string
	Target string
	Kind   string
}

type GenerateRequest struct {
	Length   int
	Save     bool
	Target   string
	Username string
	Upper    bool
	Lower    bool
	Digits   bool
	Symbols  bool
}

type GenerateResult struct {
	Password string      `json:"password"`
	Saved    *Credential `json:"saved,omitempty"`
}

func ParseList(raw json.RawMessage) (ListRequest, error) {
	req := ListRequest{Sources: []string{"windows", "browser", "apps"}}
	if len(raw) == 0 || string(raw) == "null" {
		return req, nil
	}
	var body struct {
		Sources []string `json:"sources"`
		Reveal  bool     `json:"reveal"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return ListRequest{}, ErrInvalidPayload
	}
	req.Reveal = body.Reveal
	if len(body.Sources) > 0 {
		var src []string
		for _, s := range body.Sources {
			switch strings.ToLower(strings.TrimSpace(s)) {
			case "windows", "browser", "apps", "generated":
				src = append(src, strings.ToLower(strings.TrimSpace(s)))
			default:
				return ListRequest{}, ErrInvalidPayload
			}
		}
		if len(src) == 0 {
			return ListRequest{}, ErrInvalidPayload
		}
		req.Sources = src
	}
	return req, nil
}

func ParseWrite(raw json.RawMessage) (WriteRequest, error) {
	var body struct {
		Source   string `json:"source"`
		Target   string `json:"target"`
		Username string `json:"username"`
		Secret   string `json:"secret"`
		Persist  string `json:"persist"`
		Comment  string `json:"comment"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return WriteRequest{}, ErrInvalidPayload
	}
	src := strings.ToLower(strings.TrimSpace(body.Source))
	if src == "" {
		src = "windows"
	}
	if src != "windows" && src != "apps" && src != "generated" {
		return WriteRequest{}, ErrInvalidPayload
	}
	target := strings.TrimSpace(body.Target)
	if target == "" || utf8.RuneCountInString(target) > maxTarget || strings.ContainsAny(target, "\r\n\x00") {
		return WriteRequest{}, ErrInvalidPayload
	}
	user := strings.TrimSpace(body.Username)
	if utf8.RuneCountInString(user) > maxUser || strings.ContainsAny(user, "\r\n\x00") {
		return WriteRequest{}, ErrInvalidPayload
	}
	if body.Secret == "" || utf8.RuneCountInString(body.Secret) > maxSecret || strings.Contains(body.Secret, "\x00") {
		return WriteRequest{}, ErrInvalidPayload
	}
	persist := strings.ToLower(strings.TrimSpace(body.Persist))
	switch persist {
	case "", "local", "session", "enterprise":
	default:
		return WriteRequest{}, ErrInvalidPayload
	}
	comment := strings.TrimSpace(body.Comment)
	if utf8.RuneCountInString(comment) > maxComment || strings.ContainsAny(comment, "\r\n\x00") {
		return WriteRequest{}, ErrInvalidPayload
	}
	return WriteRequest{Source: src, Target: target, Username: user, Secret: body.Secret, Persist: persist, Comment: comment}, nil
}

func ParseDelete(raw json.RawMessage) (DeleteRequest, error) {
	var body struct {
		Source string `json:"source"`
		Target string `json:"target"`
		Kind   string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return DeleteRequest{}, ErrInvalidPayload
	}
	target := strings.TrimSpace(body.Target)
	if target == "" || utf8.RuneCountInString(target) > maxTarget {
		return DeleteRequest{}, ErrInvalidPayload
	}
	src := strings.ToLower(strings.TrimSpace(body.Source))
	if src == "" {
		src = "windows"
	}
	return DeleteRequest{Source: src, Target: target, Kind: strings.ToLower(strings.TrimSpace(body.Kind))}, nil
}

func ParseGenerate(raw json.RawMessage) (GenerateRequest, error) {
	req := GenerateRequest{Length: 20, Upper: true, Lower: true, Digits: true, Symbols: true}
	if len(raw) == 0 || string(raw) == "null" {
		return req, nil
	}
	var body struct {
		Length   int   `json:"length"`
		Save     bool  `json:"save"`
		Target   string `json:"target"`
		Username string `json:"username"`
		Upper    *bool `json:"upper"`
		Lower    *bool `json:"lower"`
		Digits   *bool `json:"digits"`
		Symbols  *bool `json:"symbols"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return GenerateRequest{}, ErrInvalidPayload
	}
	if body.Length != 0 {
		if body.Length < 8 || body.Length > 64 {
			return GenerateRequest{}, ErrInvalidPayload
		}
		req.Length = body.Length
	}
	req.Save = body.Save
	req.Target = strings.TrimSpace(body.Target)
	req.Username = strings.TrimSpace(body.Username)
	if utf8.RuneCountInString(req.Target) > maxTarget || utf8.RuneCountInString(req.Username) > maxUser {
		return GenerateRequest{}, ErrInvalidPayload
	}
	if req.Save && req.Target == "" {
		return GenerateRequest{}, ErrInvalidPayload
	}
	if body.Upper != nil {
		req.Upper = *body.Upper
	}
	if body.Lower != nil {
		req.Lower = *body.Lower
	}
	if body.Digits != nil {
		req.Digits = *body.Digits
	}
	if body.Symbols != nil {
		req.Symbols = *body.Symbols
	}
	if !req.Upper && !req.Lower && !req.Digits && !req.Symbols {
		return GenerateRequest{}, ErrInvalidPayload
	}
	return req, nil
}

func charsetFor(req GenerateRequest) string {
	var b strings.Builder
	if req.Lower {
		b.WriteString("abcdefghijkmnopqrstuvwxyz")
	}
	if req.Upper {
		b.WriteString("ABCDEFGHJKLMNPQRSTUVWXYZ")
	}
	if req.Digits {
		b.WriteString("23456789")
	}
	if req.Symbols {
		b.WriteString("!@#$%^&*")
	}
	s := b.String()
	if s == "" {
		return charset
	}
	return s
}

func RandomPassword(n int) (string, error) {
	return RandomPasswordCharset(n, charset)
}

func RandomPasswordCharset(n int, set string) (string, error) {
	if n < 8 {
		n = 8
	}
	if n > 64 {
		n = 64
	}
	if set == "" {
		set = charset
	}
	out := make([]byte, n)
	mod := 256 % len(set)
	limit := 256 - mod
	i := 0
	for i < n {
		var b [1]byte
		if _, err := rand.Read(b[:]); err != nil {
			return "", err
		}
		if mod != 0 && int(b[0]) >= limit {
			continue
		}
		out[i] = set[int(b[0])%len(set)]
		i++
	}
	return string(out), nil
}

func CredKey(source, target, username string) string {
	return strings.ToLower(source + "|" + target + "|" + username)
}

type RestoreRequest struct {
	Credentials []WriteRequest
}

const maxRestore = 50

func ParseRestore(raw json.RawMessage) (RestoreRequest, error) {
	var body struct {
		Credentials []json.RawMessage `json:"credentials"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return RestoreRequest{}, ErrInvalidPayload
	}
	if len(body.Credentials) == 0 || len(body.Credentials) > maxRestore {
		return RestoreRequest{}, ErrInvalidPayload
	}
	out := RestoreRequest{Credentials: make([]WriteRequest, 0, len(body.Credentials))}
	for _, item := range body.Credentials {
		w, err := ParseWrite(item)
		if err != nil {
			return RestoreRequest{}, err
		}
		out.Credentials = append(out.Credentials, w)
	}
	return out, nil
}

func ParseFirefoxLogins(raw []byte, profile string) []Credential {
	var body struct {
		Logins []struct {
			Hostname          string `json:"hostname"`
			EncryptedUsername string `json:"encryptedUsername"`
			GUID              string `json:"guid"`
			TimesUsed         int    `json:"timesUsed"`
			TimeLastUsed      int64  `json:"timeLastUsed"`
			TimeCreated       int64  `json:"timeCreated"`
		} `json:"logins"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return nil
	}
	out := make([]Credential, 0, len(body.Logins))
	for _, row := range body.Logins {
		host := strings.TrimSpace(row.Hostname)
		if host == "" {
			continue
		}
		c := Credential{
			Key:      CredKey("browser", host, row.GUID),
			Source:   "browser",
			Kind:     "password",
			Target:   host,
			Browser:  "firefox",
			Profile:  profile,
			Locked:   true,
			Comment:  "Firefox metadata only (NSS key4.db is not decrypted)",
		}
		if row.TimesUsed > 0 {
			c.Comment = c.Comment + "; used " + strconv.Itoa(row.TimesUsed) + "x"
		}
		if ts := firefoxTime(row.TimeLastUsed); ts != "" {
			c.LastWritten = ts
		} else if ts := firefoxTime(row.TimeCreated); ts != "" {
			c.LastWritten = ts
		}
		out = append(out, c)
	}
	return out
}

func firefoxTime(ms int64) string {
	if ms <= 0 {
		return ""
	}
	if ms > 1e12 {
		ms = ms / 1000
	}
	t := time.Unix(ms, 0).UTC()
	if t.Year() < 2000 {
		return ""
	}
	return t.Format(time.RFC3339)
}

const chromeEpochDelta = int64(11644473600)

func chromeTime(raw string) string {
	n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || n <= 0 {
		return ""
	}
	var sec int64
	switch {
	case n > 1e15:
		sec = n/1e6 - chromeEpochDelta
	case n > 1e12:
		sec = n/1e3 - chromeEpochDelta
		if sec < 0 {
			sec = n / 1e6
		}
	default:
		sec = n - chromeEpochDelta
	}
	if sec < 0 {
		return ""
	}
	t := time.Unix(sec, 0).UTC()
	if t.Year() < 2000 || t.Year() > 2100 {
		return ""
	}
	return t.Format(time.RFC3339)
}

func Generate(req GenerateRequest) (*GenerateResult, error) {
	pw, err := RandomPasswordCharset(req.Length, charsetFor(req))
	if err != nil {
		return nil, err
	}
	out := &GenerateResult{Password: pw}
	if !req.Save {
		return out, nil
	}
	saved, err := Write(WriteRequest{
		Source:   "generated",
		Target:   req.Target,
		Username: req.Username,
		Secret:   pw,
		Persist:  "local",
		Comment:  "generated by dashboard",
	})
	if err != nil {
		return out, err
	}
	if saved != nil {
		saved.Secret = pw
	}
	out.Saved = saved
	return out, nil
}

func tally(out *ListResult) {
	for _, c := range out.Credentials {
		switch c.Source {
		case "browser":
			out.Counts.Browser++
		case "apps":
			out.Counts.Apps++
		case "generated":
			out.Counts.Generated++
		default:
			out.Counts.Windows++
		}
		if c.Locked {
			out.Counts.Locked++
		}
	}
	out.Counts.Total = len(out.Credentials)
}

func wants(req ListRequest, source string) bool {
	for _, s := range req.Sources {
		if s == source {
			return true
		}
	}
	return false
}
