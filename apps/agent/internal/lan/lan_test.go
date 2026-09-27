package lan

import (
	"net"
	"testing"
)

func TestIsPrivate(t *testing.T) {
	yes := []string{"10.0.0.5", "172.16.1.9", "192.168.1.20", "fd12:3456:789a::1", "fc00::1"}
	no := []string{"8.8.8.8", "127.0.0.1", "169.254.1.1", "::1", "fe80::1", "172.15.0.1"}
	for _, s := range yes {
		if !IsPrivate(net.ParseIP(s)) {
			t.Fatalf("want private %s", s)
		}
	}
	for _, s := range no {
		if IsPrivate(net.ParseIP(s)) {
			t.Fatalf("want public/skip %s", s)
		}
	}
}

func TestAddrsOmitsLoopback(t *testing.T) {
	for _, a := range Addrs() {
		ip := net.ParseIP(a)
		if ip == nil || !IsPrivate(ip) || ip.IsLoopback() {
			t.Fatalf("unexpected addr %s", a)
		}
	}
}
