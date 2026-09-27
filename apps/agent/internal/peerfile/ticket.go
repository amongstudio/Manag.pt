package peerfile

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type Ticket struct {
	CopyID      string   `json:"copyId"`
	SrcDeviceID string   `json:"srcDeviceId"`
	DstDeviceID string   `json:"dstDeviceId"`
	SrcPath     string   `json:"srcPath"`
	DestPath    string   `json:"destPath"`
	Exp         int64    `json:"exp"`
	MaxBytes    int64    `json:"maxBytes"`
	Port        int      `json:"port"`
	Addrs       []string `json:"addrs"`
	Sig         string   `json:"sig"`
}

func ParseTicket(raw json.RawMessage) (Ticket, error) {
	var wrap struct {
		Ticket Ticket `json:"ticket"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		return Ticket{}, err
	}
	if wrap.Ticket.CopyID == "" || wrap.Ticket.Sig == "" {
		return Ticket{}, fmt.Errorf("invalid ticket")
	}
	if wrap.Ticket.Port <= 0 || wrap.Ticket.Port > 65535 {
		return Ticket{}, fmt.Errorf("invalid ticket port")
	}
	return wrap.Ticket, nil
}

func (t Ticket) Expired(now time.Time) bool {
	return t.Exp > 0 && now.Unix() > t.Exp
}

func ticketsEqual(a, b Ticket) bool {
	if a.CopyID != b.CopyID || a.SrcDeviceID != b.SrcDeviceID || a.DstDeviceID != b.DstDeviceID {
		return false
	}
	if a.SrcPath != b.SrcPath || a.DestPath != b.DestPath {
		return false
	}
	if a.Exp != b.Exp || a.MaxBytes != b.MaxBytes || a.Port != b.Port {
		return false
	}
	if !addrsEqual(a.Addrs, b.Addrs) {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(strings.ToLower(a.Sig)), []byte(strings.ToLower(b.Sig))) != 1 {
		return false
	}
	return true
}

func addrsEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]int{}
	for _, s := range a {
		seen[s]++
	}
	for _, s := range b {
		if seen[s] == 0 {
			return false
		}
		seen[s]--
	}
	return true
}
