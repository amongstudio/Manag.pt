package mesh

import (
	"encoding/binary"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/pc-manager/agent/internal/lan"
)

const (
	beaconMagic   = "MNAGB1"
	mdnsGroup     = "224.0.0.251:5353"
	beaconGroup   = "239.255.77.91"
	mdnsService   = "_mnag._tcp.local"
	discoverEvery = 5 * time.Second
	peerTTL       = 45 * time.Second
)

type Peer struct {
	ID       string
	Addrs    []string
	Port     int
	LastSeen time.Time
}

type roster struct {
	mu    sync.Mutex
	peers map[string]Peer
}

func newRoster() *roster {
	return &roster{peers: map[string]Peer{}}
}

func (r *roster) note(id, addr string, port int) {
	id = strings.TrimSpace(id)
	if id == "" || addr == "" {
		return
	}
	if port <= 0 || port > 65535 {
		port = lan.DefaultPort
	}
	ip := net.ParseIP(addr)
	if ip == nil || !lan.IsPrivate(ip) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.peers[id]
	p.ID = id
	p.Port = port
	p.LastSeen = time.Now()
	found := false
	for _, a := range p.Addrs {
		if a == addr {
			found = true
			break
		}
	}
	if !found {
		p.Addrs = append(p.Addrs, addr)
		if len(p.Addrs) > 8 {
			p.Addrs = p.Addrs[len(p.Addrs)-8:]
		}
	}
	r.peers[id] = p
}

func (r *roster) addrs(id string) (addrs []string, port int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.peers[id]
	if !ok || time.Since(p.LastSeen) > peerTTL {
		return nil, 0
	}
	return append([]string(nil), p.Addrs...), p.Port
}

func marshalBeacon(id string, port int) []byte {
	idb := []byte(id)
	if len(idb) > 255 {
		idb = idb[:255]
	}
	out := make([]byte, 8+len(idb)+2)
	copy(out, beaconMagic)
	out[6] = 1
	out[7] = byte(len(idb))
	copy(out[8:], idb)
	binary.BigEndian.PutUint16(out[8+len(idb):], uint16(port))
	return out[:8+len(idb)+2]
}

func unmarshalBeacon(b []byte) (id string, port int, err error) {
	if len(b) < 10 || string(b[:6]) != beaconMagic || b[6] != 1 {
		return "", 0, fmt.Errorf("not a beacon")
	}
	n := int(b[7])
	if n <= 0 || 8+n+2 > len(b) {
		return "", 0, fmt.Errorf("bad beacon")
	}
	id = string(b[8 : 8+n])
	port = int(binary.BigEndian.Uint16(b[8+n : 8+n+2]))
	return id, port, nil
}

func sendBeacons(conn *net.UDPConn, id string, port int) {
	payload := marshalBeacon(id, port)
	targets := []*net.UDPAddr{
		{IP: net.IPv4bcast, Port: port},
		{IP: net.ParseIP(beaconGroup), Port: port},
	}
	for _, addr := range lan.Addrs() {
		ip := net.ParseIP(addr)
		if ip == nil || ip.To4() == nil {
			continue
		}
		v4 := ip.To4()
		bcast := net.IPv4(v4[0], v4[1], v4[2], 255)
		targets = append(targets, &net.UDPAddr{IP: bcast, Port: port})
	}
	seen := map[string]struct{}{}
	for _, t := range targets {
		if t == nil || t.IP == nil {
			continue
		}
		k := t.String()
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		_, _ = conn.WriteToUDP(payload, t)
	}
}

func localUDPAddr(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}

func encodeMDNSAnnounce(instance string, port int, ips []net.IP) []byte {
	// Best-effort unicast-like multicast DNS response: PTR + SRV + TXT + A.
	name := strings.ToLower(strings.TrimSpace(instance))
	if name == "" {
		name = "mnag"
	}
	svc := mdnsService
	inst := name + "." + svc
	var buf []byte
	hdr := make([]byte, 12)
	hdr[2] = 0x84
	hdr[3] = 0x00
	binary.BigEndian.PutUint16(hdr[6:], 2) // ANCOUNT PTR+SRV; TXT/A extra
	buf = append(buf, hdr...)
	ptr := dnsName(svc)
	ptr = append(ptr, dnsName(inst)...)
	buf = appendRR(buf, svc, 12, ptr) // PTR
	srv := make([]byte, 6)
	binary.BigEndian.PutUint16(srv[4:], uint16(port))
	srv = append(srv, dnsName(name+".local")...)
	buf = appendRR(buf, inst, 33, srv)
	binary.BigEndian.PutUint16(buf[6:], 2+uint16(len(ips)))
	for _, ip := range ips {
		v4 := ip.To4()
		if v4 == nil {
			continue
		}
		buf = appendRR(buf, name+".local", 1, v4)
	}
	return buf
}

func dnsName(name string) []byte {
	var out []byte
	for _, lab := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		if lab == "" {
			continue
		}
		b := []byte(lab)
		if len(b) > 63 {
			b = b[:63]
		}
		out = append(out, byte(len(b)))
		out = append(out, b...)
	}
	out = append(out, 0)
	return out
}

func appendRR(buf []byte, name string, typ uint16, rdata []byte) []byte {
	buf = append(buf, dnsName(name)...)
	tmp := make([]byte, 10)
	binary.BigEndian.PutUint16(tmp[0:], typ)
	binary.BigEndian.PutUint16(tmp[2:], 1) // IN
	binary.BigEndian.PutUint32(tmp[4:], 15)
	binary.BigEndian.PutUint16(tmp[8:], uint16(len(rdata)))
	buf = append(buf, tmp...)
	buf = append(buf, rdata...)
	return buf
}
