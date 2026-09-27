package mesh

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const hintsFile = "mesh-wan.json"

type IceJSON struct {
	URLs       json.RawMessage `json:"urls"`
	Username   string          `json:"username,omitempty"`
	Credential string          `json:"credential,omitempty"`
}

type PeerHint struct {
	ID       string   `json:"id"`
	LanAddrs []string `json:"lanAddrs,omitempty"`
	IP       string   `json:"ip,omitempty"`
	LanPort  int      `json:"lanPort,omitempty"`
}

type wanDisk struct {
	IceServers []IceJSON  `json:"iceServers,omitempty"`
	IP         string     `json:"ip,omitempty"`
	Peers      []PeerHint `json:"peers,omitempty"`
}

func (m *Manager) ApplyWAN(ice []IceJSON, ip string, peers []PeerHint) {
	m.mu.Lock()
	if len(ice) > 0 {
		m.ice = ice
	}
	if strings.TrimSpace(ip) != "" {
		m.pubIP = strings.TrimSpace(ip)
	}
	if peers != nil {
		m.hints = peers
	}
	iceOut := append([]IceJSON(nil), m.ice...)
	pub := m.pubIP
	hints := append([]PeerHint(nil), m.hints...)
	dir := m.dataDir
	m.mu.Unlock()
	raw, err := json.Marshal(wanDisk{IceServers: iceOut, IP: pub, Peers: hints})
	if err != nil {
		return
	}
	_ = writeRestricted(filepath.Join(dir, hintsFile), raw, 0o644)
}

func (m *Manager) loadHints() {
	raw, err := os.ReadFile(filepath.Join(m.dataDir, hintsFile))
	if err != nil {
		return
	}
	var d wanDisk
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	m.ice = d.IceServers
	m.pubIP = d.IP
	m.hints = d.Peers
}

func (m *Manager) hintAddrs(id string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.hints {
		if strings.EqualFold(p.ID, id) {
			return append([]string(nil), p.LanAddrs...)
		}
	}
	return nil
}

func (m *Manager) hintPublicIP(id string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.hints {
		if strings.EqualFold(p.ID, id) {
			return strings.TrimSpace(p.IP)
		}
	}
	return ""
}

func (m *Manager) hintPort(id string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.hints {
		if strings.EqualFold(p.ID, id) && p.LanPort > 0 {
			return p.LanPort
		}
	}
	return 0
}

func (i IceJSON) urlList() []string {
	if len(i.URLs) == 0 {
		return nil
	}
	var one string
	if json.Unmarshal(i.URLs, &one) == nil && one != "" {
		return []string{one}
	}
	var many []string
	if json.Unmarshal(i.URLs, &many) == nil {
		return many
	}
	return nil
}

func hasTURN(ice []IceJSON) bool {
	for _, s := range ice {
		for _, u := range s.urlList() {
			l := strings.ToLower(strings.TrimSpace(u))
			if strings.HasPrefix(l, "turn:") || strings.HasPrefix(l, "turns:") {
				return true
			}
		}
	}
	return false
}
