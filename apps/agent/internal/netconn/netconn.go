// Package netconn reports visible connection metadata: endpoints, state,
// owning process, and OS byte counters. It never captures packets, payloads,
// DNS queries, or HTTP content.
package netconn

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	gnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
)

const (
	DefaultLimit = 500
	MaxLimit     = 1000
	maxProcIO    = 100
)

type Request struct {
	IncludeListening bool `json:"includeListening"`
	Limit            int  `json:"limit"`
}

type Connection struct {
	Protocol   string `json:"protocol"`
	LocalAddr  string `json:"localAddr"`
	LocalPort  uint32 `json:"localPort"`
	RemoteAddr string `json:"remoteAddr,omitempty"`
	RemotePort uint32 `json:"remotePort,omitempty"`
	State      string `json:"state,omitempty"`
	PID        int32  `json:"pid,omitempty"`
	Process    string `json:"process,omitempty"`
}

type InterfaceIO struct {
	Name      string `json:"name"`
	BytesSent uint64 `json:"bytesSent"`
	BytesRecv uint64 `json:"bytesRecv"`
}

// ProcessIO is total process I/O from the OS (disk and network combined on
// Windows); it is labeled as such in the dashboard.
type ProcessIO struct {
	PID        int32  `json:"pid"`
	Process    string `json:"process,omitempty"`
	ReadBytes  uint64 `json:"readBytes"`
	WriteBytes uint64 `json:"writeBytes"`
}

type Result struct {
	Connections []Connection  `json:"connections"`
	Interfaces  []InterfaceIO `json:"interfaces"`
	ProcessIO   []ProcessIO   `json:"processIo"`
	Total       int           `json:"total"`
	Truncated   bool          `json:"truncated,omitempty"`
	CollectedAt string        `json:"collectedAt"`
	ByteCounts  string        `json:"byteCounts"`
}

func Parse(raw json.RawMessage) (Request, error) {
	req := Request{Limit: DefaultLimit}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &req); err != nil {
			return req, errors.New("invalid_payload")
		}
	}
	if req.Limit <= 0 {
		req.Limit = DefaultLimit
	}
	if req.Limit > MaxLimit {
		return req, errors.New("limit_too_large")
	}
	return req, nil
}

func protocolName(family, typ uint32) string {
	proto := "tcp"
	if typ == 2 {
		proto = "udp"
	}
	if family == 23 || family == 10 {
		proto += "6"
	}
	return proto
}

func listening(c gnet.ConnectionStat) bool {
	if strings.EqualFold(c.Status, "LISTEN") {
		return true
	}
	return c.Type == 2 && c.Raddr.IP == "" && c.Raddr.Port == 0
}

// Filter applies listening/limit rules and orders established first.
func Filter(stats []gnet.ConnectionStat, req Request, names func(int32) string) ([]Connection, int, bool) {
	out := make([]Connection, 0, len(stats))
	for _, c := range stats {
		if !req.IncludeListening && listening(c) {
			continue
		}
		conn := Connection{
			Protocol:   protocolName(c.Family, c.Type),
			LocalAddr:  c.Laddr.IP,
			LocalPort:  c.Laddr.Port,
			RemoteAddr: c.Raddr.IP,
			RemotePort: c.Raddr.Port,
			State:      c.Status,
			PID:        c.Pid,
		}
		if names != nil && c.Pid > 0 {
			conn.Process = names(c.Pid)
		}
		out = append(out, conn)
	}
	sort.SliceStable(out, func(i, j int) bool {
		ei, ej := out[i].State == "ESTABLISHED", out[j].State == "ESTABLISHED"
		if ei != ej {
			return ei
		}
		return out[i].Process < out[j].Process
	})
	total := len(out)
	if total > req.Limit {
		return out[:req.Limit], total, true
	}
	return out, total, false
}

func Collect(ctx context.Context, req Request) (*Result, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	stats, err := gnet.ConnectionsWithContext(ctx, "inet")
	if err != nil {
		return nil, err
	}
	cache := map[int32]string{}
	names := func(pid int32) string {
		if name, ok := cache[pid]; ok {
			return name
		}
		name := ""
		if p, err := process.NewProcessWithContext(ctx, pid); err == nil {
			name, _ = p.NameWithContext(ctx)
		}
		cache[pid] = name
		return name
	}
	conns, total, truncated := Filter(stats, req, names)
	res := &Result{
		Connections: conns,
		Total:       total,
		Truncated:   truncated,
		CollectedAt: time.Now().UTC().Format(time.RFC3339),
		ByteCounts:  "Per-connection byte counts are not exposed by the OS; interface counters and per-process I/O totals are shown instead.",
		Interfaces:  []InterfaceIO{},
		ProcessIO:   []ProcessIO{},
	}
	if ifaces, err := gnet.IOCountersWithContext(ctx, true); err == nil {
		for _, io := range ifaces {
			if io.BytesSent == 0 && io.BytesRecv == 0 {
				continue
			}
			res.Interfaces = append(res.Interfaces, InterfaceIO{Name: io.Name, BytesSent: io.BytesSent, BytesRecv: io.BytesRecv})
		}
	}
	seen := map[int32]bool{}
	for _, c := range conns {
		if c.PID <= 0 || seen[c.PID] || len(res.ProcessIO) >= maxProcIO {
			continue
		}
		seen[c.PID] = true
		p, err := process.NewProcessWithContext(ctx, c.PID)
		if err != nil {
			continue
		}
		io, err := p.IOCountersWithContext(ctx)
		if err != nil || io == nil {
			continue
		}
		res.ProcessIO = append(res.ProcessIO, ProcessIO{PID: c.PID, Process: c.Process, ReadBytes: io.ReadBytes, WriteBytes: io.WriteBytes})
	}
	return res, nil
}
