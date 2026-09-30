package netconn

import (
	"encoding/json"
	"testing"

	gnet "github.com/shirou/gopsutil/v4/net"
)

func TestParseBounds(t *testing.T) {
	req, err := Parse(nil)
	if err != nil || req.Limit != DefaultLimit {
		t.Fatalf("req=%+v err=%v", req, err)
	}
	if _, err := Parse(json.RawMessage(`{"limit":5000}`)); err == nil {
		t.Fatal("oversized limit accepted")
	}
}

func TestFilterSkipsListeningAndCaps(t *testing.T) {
	stats := []gnet.ConnectionStat{
		{Family: 2, Type: 1, Status: "LISTEN", Laddr: gnet.Addr{IP: "0.0.0.0", Port: 445}, Pid: 4},
		{Family: 2, Type: 1, Status: "ESTABLISHED", Laddr: gnet.Addr{IP: "10.0.0.2", Port: 50000}, Raddr: gnet.Addr{IP: "10.0.0.9", Port: 443}, Pid: 10},
		{Family: 23, Type: 1, Status: "TIME_WAIT", Laddr: gnet.Addr{IP: "::1", Port: 50001}, Raddr: gnet.Addr{IP: "::1", Port: 80}},
		{Family: 2, Type: 2, Laddr: gnet.Addr{IP: "0.0.0.0", Port: 53}, Pid: 12},
	}
	names := func(pid int32) string { return map[int32]string{10: "chrome.exe", 4: "System"}[pid] }
	conns, total, truncated := Filter(stats, Request{Limit: 10}, names)
	if total != 2 || truncated || conns[0].State != "ESTABLISHED" || conns[0].Process != "chrome.exe" || conns[1].Protocol != "tcp6" {
		t.Fatalf("conns=%+v total=%d", conns, total)
	}
	all, total, _ := Filter(stats, Request{Limit: 10, IncludeListening: true}, names)
	if total != 4 || len(all) != 4 {
		t.Fatalf("all=%+v", all)
	}
	capped, total, truncated := Filter(stats, Request{Limit: 1, IncludeListening: true}, names)
	if len(capped) != 1 || total != 4 || !truncated {
		t.Fatalf("capped=%+v", capped)
	}
}
