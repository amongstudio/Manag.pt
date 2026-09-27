package lan

import (
	"net"
	"sort"
	"strings"
)

const DefaultPort = 17891

func Port() int {
	return DefaultPort
}

func Addrs() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return []string{}
	}
	seen := map[string]struct{}{}
	var out []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ip := ipFromAddr(a)
			if ip == nil || !IsPrivate(ip) {
				continue
			}
			s := ip.String()
			if _, ok := seen[s]; ok {
				continue
			}
			seen[s] = struct{}{}
			out = append(out, s)
			if len(out) >= 16 {
				sort.Strings(out)
				return out
			}
		}
	}
	sort.Strings(out)
	if out == nil {
		return []string{}
	}
	return out
}

func ipFromAddr(a net.Addr) net.IP {
	switch v := a.(type) {
	case *net.IPNet:
		return v.IP
	case *net.IPAddr:
		return v.IP
	default:
		host, _, err := net.SplitHostPort(a.String())
		if err != nil {
			host = a.String()
		}
		return net.ParseIP(strings.TrimSpace(host))
	}
}

func IsPrivate(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		return v4[0] == 10 || (v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] == 192 && v4[1] == 168)
	}
	if ip.To16() == nil {
		return false
	}
	return ip[0]&0xfe == 0xfc
}
