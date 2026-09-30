package mesh

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pc-manager/agent/internal/client"
	"github.com/pc-manager/agent/internal/filemanager"
	"github.com/pc-manager/agent/internal/lan"
	"github.com/pc-manager/agent/internal/notify"
	"github.com/pc-manager/agent/internal/peerfile"
)

const waitTimeout = 20 * time.Second

type Logger func(format string, args ...any)

type ExecFunc func(typ string, payload json.RawMessage) (any, error)

type SignalFunc func(v any) error

type incoming struct {
	conn   net.Conn
	hdr    peerfile.FileHead
	peerID string
}

type Manager struct {
	mu       sync.Mutex
	dataDir  string
	deviceID string
	sandbox  func() *filemanager.Sandbox
	log      Logger

	policy  Policy
	ident   *Identity
	revoked map[string]struct{}
	audit   *Audit
	peers   *roster

	ln           net.Listener
	udp          *net.UDPConn
	mdns         *net.UDPConn
	stop         chan struct{}
	listenSerial string

	waiters map[string]chan incoming

	exec   ExecFunc
	signal SignalFunc
	ice    []IceJSON
	pubIP  string
	hints  []PeerHint

	wanMu     sync.Mutex
	wanSess   map[string]*wanSession
	relayWait map[string]chan relayReply
	conns     atomic.Int32
}

func New(dataDir, deviceID string, sandbox func() *filemanager.Sandbox, log Logger) *Manager {
	m := &Manager{
		dataDir:   dataDir,
		deviceID:  deviceID,
		sandbox:   sandbox,
		log:       log,
		policy:    LoadPolicy(dataDir),
		revoked:   LoadCRL(dataDir),
		audit:     NewAudit(dataDir),
		peers:     newRoster(),
		waiters:   map[string]chan incoming{},
		wanSess:   map[string]*wanSession{},
		relayWait: map[string]chan relayReply{},
	}
	if ident, err := LoadIdentity(dataDir, deviceID); err == nil {
		m.ident = ident
	}
	m.loadHints()
	return m
}

func (m *Manager) note(format string, args ...any) {
	if m.log != nil {
		m.log(format, args...)
	}
}

func (m *Manager) Enabled() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.policy.Enabled
}

func (m *Manager) Serial() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ident == nil {
		return ""
	}
	return m.ident.Serial
}

func (m *Manager) SetDeviceID(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.deviceID = id
}

func (m *Manager) Install(b Bundle) {
	if strings.TrimSpace(b.CA) != "" || (strings.TrimSpace(b.Cert) != "" && strings.TrimSpace(b.Key) != "") {
		if err := StoreBundle(m.dataDir, b); err != nil {
			m.note("mesh store certs: %v", err)
		}
	}
	if b.RevokedSerials != nil {
		_ = StoreCRL(m.dataDir, b.RevokedSerials)
	}
	m.mu.Lock()
	m.revoked = LoadCRL(m.dataDir)
	if ident, err := LoadIdentity(m.dataDir, m.deviceID); err == nil {
		m.ident = ident
	}
	m.mu.Unlock()
	m.reconcile()
}

func (m *Manager) SetPolicy(p Policy) {
	_ = StorePolicy(m.dataDir, p)
	m.mu.Lock()
	m.policy = p
	m.mu.Unlock()
	m.reconcile()
}

func (m *Manager) StartFromDisk() {
	m.mu.Lock()
	m.policy = LoadPolicy(m.dataDir)
	m.revoked = LoadCRL(m.dataDir)
	if ident, err := LoadIdentity(m.dataDir, m.deviceID); err == nil {
		m.ident = ident
	}
	m.mu.Unlock()
	m.reconcile()
}

func (m *Manager) FlushAudit() []map[string]any {
	return m.audit.Drain()
}

func (m *Manager) RestoreAudit(entries []map[string]any) {
	m.audit.Restore(entries)
}

func (m *Manager) SetExec(fn ExecFunc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.exec = fn
}

func (m *Manager) SetSignal(fn SignalFunc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.signal = fn
}

func (m *Manager) CommandAllowed(typ string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return CommandAllowed(m.policy, typ)
}

func (m *Manager) WANEnabled() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.policy.Enabled && m.policy.WAN && hasTURN(m.ice)
}

func (m *Manager) SignalUp() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.signal != nil
}

func (m *Manager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked()
}

func (m *Manager) stopLocked() {
	if m.stop != nil {
		select {
		case <-m.stop:
		default:
			close(m.stop)
		}
		m.stop = nil
	}
	if m.ln != nil {
		_ = m.ln.Close()
		m.ln = nil
	}
	if m.udp != nil {
		_ = m.udp.Close()
		m.udp = nil
	}
	if m.mdns != nil {
		_ = m.mdns.Close()
		m.mdns = nil
	}
}

func (m *Manager) reconcile() {
	m.mu.Lock()
	defer m.mu.Unlock()
	want := m.policy.Enabled && m.ident != nil && !m.ident.Expired(time.Now())
	serial := ""
	if m.ident != nil {
		serial = m.ident.Serial
	}
	if want && m.ln != nil && m.listenSerial == serial {
		return
	}
	if m.ln != nil {
		m.note("mesh listener stopped")
	}
	m.stopLocked()
	m.listenSerial = ""
	if !want {
		return
	}
	stop := make(chan struct{})
	m.stop = stop
	ident := m.ident
	port := lan.Port()
	ln, err := tls.Listen("tcp", net.JoinHostPort("", strconv.Itoa(port)), ident.TLSConfig(true, "", cloneRevoked(m.revoked)))
	if err != nil {
		m.note("mesh listen %d: %v", port, err)
		m.stop = nil
		return
	}
	m.ln = ln
	m.listenSerial = serial
	if udp, err := net.ListenUDP("udp4", &net.UDPAddr{Port: port}); err != nil {
		m.note("mesh beacon %d: %v", port, err)
	} else {
		m.udp = udp
	}
	if mdns, err := net.ListenMulticastUDP("udp4", nil, &net.UDPAddr{IP: net.ParseIP("224.0.0.251"), Port: 5353}); err == nil {
		m.mdns = mdns
	}
	deviceID := ident.DeviceID
	go m.acceptLoop(ln, stop)
	if m.udp != nil {
		go m.beaconLoop(m.udp, deviceID, port, stop)
	}
	if m.mdns != nil {
		go m.mdnsLoop(m.mdns, deviceID, port, stop)
	}
	m.note("mesh listener on %d", port)
}

func cloneRevoked(in map[string]struct{}) map[string]struct{} {
	out := map[string]struct{}{}
	for k := range in {
		out[k] = struct{}{}
	}
	return out
}

func acquireCount(n *atomic.Int32, max int32) bool {
	for {
		cur := n.Load()
		if cur >= max {
			return false
		}
		if n.CompareAndSwap(cur, cur+1) {
			return true
		}
	}
}

func releaseCount(n *atomic.Int32) {
	n.Add(-1)
}

func (m *Manager) acceptLoop(ln net.Listener, stop <-chan struct{}) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-stop:
				return
			default:
				return
			}
		}
		if !acquireCount(&m.conns, 32) {
			_ = conn.Close()
			continue
		}
		go func(c net.Conn) {
			defer releaseCount(&m.conns)
			m.handleConn(c)
		}(conn)
	}
}

func (m *Manager) handleConn(conn net.Conn) {
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	tlsConn, ok := conn.(*tls.Conn)
	if ok {
		if err := tlsConn.Handshake(); err != nil {
			_ = conn.Close()
			return
		}
	} else {
		_ = conn.Close()
		return
	}
	state := tlsConn.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		_ = conn.Close()
		return
	}
	peerID, err := DeviceIDFromCert(state.PeerCertificates[0])
	if err != nil {
		_ = conn.Close()
		return
	}
	hdr, err := peerfile.ReadPeer(conn)
	if err != nil {
		_ = conn.Close()
		return
	}
	if peerfile.ForbiddenOp(hdr.Op) {
		_ = peerfile.WriteError(conn, "peer_refused")
		m.audit.Append(AuditEntry{Op: hdr.Op, PeerID: peerID, OK: false, Error: "forbidden"})
		_ = conn.Close()
		return
	}
	if peerfile.IsCmdOp(hdr.Op) {
		m.handleCmd(conn, hdr, peerID)
		return
	}
	if !peerfile.IsFileOp(hdr.Op) {
		_ = peerfile.WriteError(conn, "peer_refused")
		m.audit.Append(AuditEntry{Op: hdr.Op, PeerID: peerID, OK: false, Error: "refused"})
		_ = conn.Close()
		return
	}
	m.mu.Lock()
	self := m.deviceID
	wait := m.waiters[hdr.CopyID]
	m.mu.Unlock()
	if hdr.DstDeviceID != "" && self != "" && !strings.EqualFold(hdr.DstDeviceID, self) {
		_ = peerfile.WriteError(conn, "peer_refused")
		_ = conn.Close()
		return
	}
	notify.PostKind(notify.KindMeshPeer)
	if wait != nil && hdr.CopyID != "" {
		select {
		case wait <- incoming{conn: conn, hdr: hdr.FileHead, peerID: peerID}:
			return
		default:
		}
	}
	m.receiveIncoming(conn, hdr.FileHead, peerID, hdr.DestPath, nil)
}

func (m *Manager) receiveIncoming(conn net.Conn, hdr peerfile.FileHead, peerID, destPath string, progress func(int)) (peerfile.Result, error) {
	defer conn.Close()
	sb := m.sandbox()
	if sb == nil {
		_ = peerfile.WriteError(conn, "peer_refused")
		return peerfile.Result{}, fmt.Errorf("sandbox required")
	}
	if strings.TrimSpace(destPath) == "" {
		destPath = hdr.DestPath
	}
	resolved, err := sb.Resolve(destPath)
	if err != nil {
		_ = peerfile.WriteError(conn, "peer_refused")
		m.audit.Append(AuditEntry{Op: "file", PeerID: peerID, Path: destPath, OK: false, Error: err.Error()})
		return peerfile.Result{}, err
	}
	if st, err := os.Stat(resolved); err == nil && st.IsDir() {
		resolved = filepath.Join(resolved, filepath.Base(hdr.SrcPath))
	}
	res, err := peerfile.ReceiveFile(conn, resolved, hdr.Size, hdr.MaxBytes, progress)
	if err != nil {
		m.audit.Append(AuditEntry{Op: "file", PeerID: peerID, Path: destPath, OK: false, Error: err.Error()})
		return peerfile.Result{}, err
	}
	m.audit.Append(AuditEntry{Op: "file", PeerID: peerID, Path: destPath, Size: res.Size, SHA256: res.SHA256, OK: true})
	return res, nil
}

func (m *Manager) beaconLoop(udp *net.UDPConn, id string, port int, stop <-chan struct{}) {
	buf := make([]byte, 2048)
	t := time.NewTicker(discoverEvery)
	defer t.Stop()
	sendBeacons(udp, id, port)
	for {
		select {
		case <-stop:
			return
		default:
		}
		_ = udp.SetReadDeadline(time.Now().Add(time.Second))
		n, addr, err := udp.ReadFromUDP(buf)
		if err == nil {
			bid, bport, berr := unmarshalBeacon(buf[:n])
			if berr == nil && bid != "" && bid != id {
				m.peers.note(bid, localUDPAddr(addr), bport)
			}
		}
		select {
		case <-stop:
			return
		case <-t.C:
			sendBeacons(udp, id, port)
		default:
		}
	}
}

func (m *Manager) mdnsLoop(conn *net.UDPConn, id string, port int, stop <-chan struct{}) {
	var ips []net.IP
	for _, a := range lan.Addrs() {
		if ip := net.ParseIP(a); ip != nil && ip.To4() != nil {
			ips = append(ips, ip)
		}
	}
	pkt := encodeMDNSAnnounce(id, port, ips)
	dst := &net.UDPAddr{IP: net.ParseIP("224.0.0.251"), Port: 5353}
	t := time.NewTicker(discoverEvery)
	defer t.Stop()
	_, _ = conn.WriteToUDP(pkt, dst)
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			_, _ = conn.WriteToUDP(pkt, dst)
		}
	}
}

func (m *Manager) WaitFile(copyID, destPath string, progress func(int)) (peerfile.Result, error) {
	ch := make(chan incoming, 1)
	m.mu.Lock()
	m.waiters[copyID] = ch
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.waiters, copyID)
		m.mu.Unlock()
	}()
	t := time.NewTimer(waitTimeout)
	defer t.Stop()
	select {
	case in := <-ch:
		return m.receiveIncoming(in.conn, in.hdr, in.peerID, destPath, progress)
	case <-t.C:
		return peerfile.Result{Via: "listen_timeout"}, nil
	}
}

func (m *Manager) OfferFile(destID, srcPath, destPath string, addrs []string, port int, copyID string, progress func(int)) (peerfile.Result, error) {
	m.mu.Lock()
	ident := m.ident
	revoked := cloneRevoked(m.revoked)
	self := m.deviceID
	m.mu.Unlock()
	if ident == nil || ident.Expired(time.Now()) {
		return peerfile.Result{}, peerfile.ErrDial
	}
	if port <= 0 {
		port = lan.DefaultPort
	}
	seen := map[string]struct{}{}
	var targets []string
	add := func(a string) {
		a = strings.TrimSpace(a)
		if a == "" {
			return
		}
		if _, ok := seen[a]; ok {
			return
		}
		seen[a] = struct{}{}
		targets = append(targets, a)
	}
	for _, a := range addrs {
		add(a)
	}
	if extra, p := m.peers.addrs(destID); len(extra) > 0 {
		if p > 0 {
			port = p
		}
		for _, a := range extra {
			add(a)
		}
	}
	for _, a := range m.hintAddrs(destID) {
		add(a)
	}
	if pub := m.hintPublicIP(destID); pub != "" {
		add(pub)
	}
	st, err := os.Stat(srcPath)
	if err != nil {
		return peerfile.Result{}, err
	}
	hdr := peerfile.MeshFileHeader(copyID, self, destID, srcPath, destPath, st.Size(), client.MaxUploadBytes())
	deadline := time.Now().Add(3 * time.Second)
	var last error
	for _, addr := range targets {
		if time.Now().After(deadline) {
			break
		}
		res, err := m.dialOne(ident, revoked, destID, addr, port, srcPath, hdr, deadline, progress)
		if err == nil {
			m.audit.Append(AuditEntry{Op: "file", PeerID: destID, Path: srcPath, Size: res.Size, SHA256: res.SHA256, OK: true})
			return res, nil
		}
		last = err
	}
	if res, err := m.offerWANFile(destID, srcPath, hdr, progress); err == nil {
		m.audit.Append(AuditEntry{Op: "file", PeerID: destID, Path: srcPath, Size: res.Size, SHA256: res.SHA256, OK: true})
		return res, nil
	} else if err != nil {
		last = err
	}
	if last == nil {
		last = peerfile.ErrDial
	}
	m.audit.Append(AuditEntry{Op: "file", PeerID: destID, Path: srcPath, OK: false, Error: last.Error()})
	return peerfile.Result{}, peerfile.ErrDial
}

func (m *Manager) dialOne(ident *Identity, revoked map[string]struct{}, destID, addr string, port int, srcPath string, hdr peerfile.FileHead, deadline time.Time, progress func(int)) (peerfile.Result, error) {
	remain := time.Until(deadline)
	if remain <= 0 {
		return peerfile.Result{}, peerfile.ErrDial
	}
	d := net.Dialer{Timeout: remain}
	raw, err := d.Dial("tcp", net.JoinHostPort(addr, strconv.Itoa(port)))
	if err != nil {
		return peerfile.Result{}, err
	}
	conn := tls.Client(raw, ident.TLSConfig(false, destID, revoked))
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	if err := conn.Handshake(); err != nil {
		return peerfile.Result{}, err
	}
	return peerfile.SendFile(conn, srcPath, hdr, progress)
}
