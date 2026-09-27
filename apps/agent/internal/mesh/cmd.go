package mesh

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pc-manager/agent/internal/commands"
	"github.com/pc-manager/agent/internal/lan"
	"github.com/pc-manager/agent/internal/notify"
	"github.com/pc-manager/agent/internal/peerfile"
)

const meshForwardKey = "meshForward"

var ErrUnreachable = errors.New("mesh_unreachable")

type cmdResult struct {
	Status string
	Result any
}

func ForwardTarget(payload json.RawMessage) string {
	var body map[string]any
	if json.Unmarshal(payload, &body) != nil {
		return ""
	}
	s, _ := body[meshForwardKey].(string)
	return strings.TrimSpace(s)
}

func StripForward(payload json.RawMessage) json.RawMessage {
	var body map[string]any
	if json.Unmarshal(payload, &body) != nil || body == nil {
		return payload
	}
	delete(body, meshForwardKey)
	raw, err := json.Marshal(body)
	if err != nil {
		return payload
	}
	return raw
}

func isMeshSecretKey(key string) bool {
	switch strings.ToLower(key) {
		case "password", "passwordenc", "secret", "secretenc", "recoverypassword", "recoverypasswordenc":
		return true
	default:
		return false
	}
}

func dropMeshSecrets(v any) {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			if isMeshSecretKey(k) {
				delete(t, k)
				continue
			}
			dropMeshSecrets(child)
		}
	case []any:
		for _, child := range t {
			dropMeshSecrets(child)
		}
	}
}

func commandCarriesSecrets(cmdType string) bool {
	switch strings.ToLower(strings.TrimSpace(cmdType)) {
	case "smb_connect", "get_credentials", "backup_credentials", "set_credential", "delete_credential", "generate_credential", "restore_credentials", "set_bitlocker":
		return true
	default:
		return false
	}
}

// StripCommandSecrets removes passwords/secrets from mesh command payloads.
// Credential commands are never allowed on mesh; smb_connect may be an extra but must not carry a password.
func StripCommandSecrets(cmdType string, payload json.RawMessage) json.RawMessage {
	if !commandCarriesSecrets(cmdType) || len(payload) == 0 {
		return payload
	}
	var body map[string]any
	if json.Unmarshal(payload, &body) != nil || body == nil {
		return payload
	}
	dropMeshSecrets(body)
	raw, err := json.Marshal(body)
	if err != nil {
		return payload
	}
	return raw
}

func (m *Manager) handleCmd(conn net.Conn, hdr peerfile.PeerHead, peerID string) {
	defer conn.Close()
	m.mu.Lock()
	self := m.deviceID
	policy := m.policy
	exec := m.exec
	m.mu.Unlock()
	if hdr.DstDeviceID != "" && self != "" && !strings.EqualFold(hdr.DstDeviceID, self) {
		_ = peerfile.WriteError(conn, "peer_refused")
		m.audit.Append(AuditEntry{Op: "cmd", PeerID: peerID, CmdType: hdr.CmdType, ResultID: hdr.ResultID, OK: false, Error: "wrong dest"})
		return
	}
	if !CommandAllowed(policy, hdr.CmdType) {
		_ = peerfile.WriteError(conn, "not_allowed")
		m.audit.Append(AuditEntry{Op: "cmd", PeerID: peerID, CmdType: hdr.CmdType, ResultID: hdr.ResultID, OK: false, Error: "not_allowed"})
		return
	}
	if exec == nil {
		_ = peerfile.WriteError(conn, "peer_refused")
		m.audit.Append(AuditEntry{Op: "cmd", PeerID: peerID, CmdType: hdr.CmdType, ResultID: hdr.ResultID, OK: false, Error: "no exec"})
		return
	}
	notify.PostKind(notify.KindMeshPeer)
	payload := hdr.Payload
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	payload = StripCommandSecrets(hdr.CmdType, payload)
	result, err := exec(hdr.CmdType, payload)
	status := "success"
	if err != nil {
		status = "failed"
		if result == nil {
			result = map[string]string{"error": err.Error()}
		}
	}
	_ = peerfile.WriteCmdResult(conn, hdr.ResultID, status, result)
	m.audit.Append(AuditEntry{
		Op: "cmd", PeerID: peerID, CmdType: hdr.CmdType, ResultID: hdr.ResultID,
		OK: err == nil, Error: errString(err),
	})
	if err == nil && commands.IsPowerCommand(hdr.CmdType) {
		go func() {
			time.Sleep(2 * time.Second)
			_ = commands.PowerAction(hdr.CmdType)
		}()
	}
}

func (m *Manager) OfferCmd(destID, cmdType string, payload json.RawMessage) (any, error) {
	m.mu.Lock()
	ident := m.ident
	revoked := cloneRevoked(m.revoked)
	self := m.deviceID
	policy := m.policy
	port := lan.Port()
	m.mu.Unlock()
	if ident == nil || ident.Expired(time.Now()) {
		return nil, ErrUnreachable
	}
	if !CommandAllowed(policy, cmdType) {
		return nil, fmt.Errorf("not_allowed")
	}
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	payload = StripCommandSecrets(cmdType, payload)
	resultID := uuid.NewString()
	targets := m.dialTargets(destID, nil, port)
	deadline := time.Now().Add(3 * time.Second)
	var last error
	for _, addr := range targets.addrs {
		if time.Now().After(deadline) {
			break
		}
		res, err := m.dialCmd(ident, revoked, destID, addr, targets.port, self, cmdType, resultID, payload, deadline)
		if err == nil {
			m.audit.Append(AuditEntry{Op: "cmd", PeerID: destID, CmdType: cmdType, ResultID: resultID, OK: res.Status != "failed"})
			return res.Result, statusErr(res)
		}
		last = err
	}
	res, err := m.offerWANCmd(destID, self, cmdType, resultID, payload)
	if err == nil {
		m.audit.Append(AuditEntry{Op: "cmd", PeerID: destID, CmdType: cmdType, ResultID: resultID, OK: res.Status != "failed"})
		return res.Result, statusErr(res)
	}
	if err != nil {
		last = err
	}
	res, err = m.relayCmd(destID, cmdType, payload, resultID)
	if err == nil {
		m.audit.Append(AuditEntry{Op: "cmd", PeerID: destID, CmdType: cmdType, ResultID: resultID, OK: res.Status != "failed"})
		return res.Result, statusErr(res)
	}
	if last == nil {
		last = err
	}
	if last == nil {
		last = ErrUnreachable
	}
	m.audit.Append(AuditEntry{Op: "cmd", PeerID: destID, CmdType: cmdType, ResultID: resultID, OK: false, Error: last.Error()})
	return nil, last
}

type dialPlan struct {
	addrs []string
	port  int
}

func (m *Manager) dialTargets(destID string, addrs []string, port int) dialPlan {
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
	hintPort := 0
	for _, a := range m.hintAddrs(destID) {
		add(a)
	}
	if p := m.hintPort(destID); p > 0 {
		hintPort = p
	}
	if pub := m.hintPublicIP(destID); pub != "" {
		add(pub)
	}
	if hintPort > 0 {
		port = hintPort
	}
	return dialPlan{addrs: targets, port: port}
}

func (m *Manager) dialCmd(ident *Identity, revoked map[string]struct{}, destID, addr string, port int, self, cmdType, resultID string, payload json.RawMessage, deadline time.Time) (cmdResult, error) {
	remain := time.Until(deadline)
	if remain <= 0 {
		return cmdResult{}, ErrUnreachable
	}
	d := net.Dialer{Timeout: remain}
	raw, err := d.Dial("tcp", net.JoinHostPort(addr, fmt.Sprintf("%d", port)))
	if err != nil {
		return cmdResult{}, err
	}
	conn := tls.Client(raw, ident.TLSConfig(false, destID, revoked))
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	if err := conn.Handshake(); err != nil {
		return cmdResult{}, err
	}
	return exchangeCmd(conn, self, destID, cmdType, resultID, payload)
}

func exchangeCmd(conn net.Conn, srcID, destID, cmdType, resultID string, payload json.RawMessage) (cmdResult, error) {
	if err := peerfile.WriteMeshCmd(conn, resultID, srcID, destID, cmdType, resultID, payload); err != nil {
		return cmdResult{}, err
	}
	got, err := peerfile.ReadCmdResult(conn)
	if err != nil {
		return cmdResult{}, err
	}
	status := got.Status
	if status == "" {
		status = "success"
	}
	var result any
	if len(got.Result) > 0 {
		_ = json.Unmarshal(got.Result, &result)
	}
	return cmdResult{Status: status, Result: result}, nil
}

func statusErr(res cmdResult) error {
	if res.Status == "failed" {
		return fmt.Errorf("peer command failed")
	}
	return nil
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
