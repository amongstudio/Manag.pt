// Package localusers lists and changes local (SAM) accounts through the
// NetUser APIs. Passwords are write-only: nothing here reads or returns one.
package localusers

import (
	"encoding/json"
	"errors"
	"strings"
)

var ErrUnsupported = errors.New("local_users_unsupported")

type User struct {
	Name              string `json:"name"`
	FullName          string `json:"fullName,omitempty"`
	Comment           string `json:"comment,omitempty"`
	SID               string `json:"sid,omitempty"`
	Enabled           bool   `json:"enabled"`
	LockedOut         bool   `json:"lockedOut"`
	Admin             bool   `json:"admin"`
	Privilege         string `json:"privilege"`
	PasswordRequired  bool   `json:"passwordRequired"`
	PasswordCanChange bool   `json:"passwordCanChange"`
	PasswordExpires   bool   `json:"passwordExpires"`
	PasswordExpired   bool   `json:"passwordExpired"`
	PasswordAgeDays   int    `json:"passwordAgeDays"`
	LastLogon         string `json:"lastLogon,omitempty"`
	AccountExpires    string `json:"accountExpires,omitempty"`
	BadPasswordCount  int    `json:"badPasswordCount"`
	LogonCount        int    `json:"logonCount"`
}

type Result struct {
	Users     []User `json:"users"`
	Computer  string `json:"computer,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

type ActionRequest struct {
	Username string `json:"username"`
	Action   string `json:"action"`
	Password string `json:"password"`
}

const (
	passwordMin = 8
	passwordMax = 127
	maxUsers    = 500
)

// ValidName mirrors isLocalAccountName in packages/shared: no domain or UPN
// forms, so actions only reach accounts in the local SAM.
func ValidName(name string) bool {
	if len(name) < 1 || len(name) > 20 || strings.TrimSpace(name) != name || strings.HasPrefix(name, "-") {
		return false
	}
	if strings.Trim(name, ". ") == "" {
		return false
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(`"/\[]:;|=,+*?<>@`, r) {
			return false
		}
	}
	return true
}

func ParseAction(raw json.RawMessage) (ActionRequest, error) {
	var req ActionRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return req, errors.New("invalid_payload")
	}
	if !ValidName(req.Username) {
		return req, errors.New("invalid_username")
	}
	switch req.Action {
	case "enable", "disable":
		if req.Password != "" {
			return req, errors.New("password_not_allowed")
		}
	case "set_password":
		if n := len([]rune(req.Password)); n < passwordMin || n > passwordMax {
			return req, errors.New("invalid_password_length")
		}
	default:
		return req, errors.New("invalid_action")
	}
	return req, nil
}
