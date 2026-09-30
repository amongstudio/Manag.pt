package mesh

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const policyFile = "mesh-policy.json"

type Policy struct {
	Enabled       bool     `json:"enabled"`
	WAN           bool     `json:"wan"`
	AllowCommands []string `json:"allowCommands"`
}

var defaultCommands = []string{
	"get_files",
	"get_processes",
	"get_services",
	"get_registry",
	"get_adapters",
	"get_ports",
	"get_firewall",
	"get_event_log",
	"get_windows_update",
	"get_admin_center",
	"get_tasks",
	"get_defender",
	"get_bitlocker",
	"get_capabilities",
	"get_smb",
	"collect_inventory",
}

var neverCommands = map[string]struct{}{
	"run_plugin":             {},
	"peer_listen":            {},
	"peer_offer":             {},
	"update_agent":           {},
	"get_credentials":        {},
	"backup_credentials":     {},
	"set_credential":         {},
	"delete_credential":      {},
	"generate_credential":    {},
	"restore_credentials":    {},
	"set_bitlocker":          {},
	"install_windows_update": {},
	"network_scan":           {},
	"nuclei_scan":            {},
}

func DefaultPolicy() Policy {
	return Policy{Enabled: false, WAN: false, AllowCommands: []string{}}
}

func CommandAllowed(p Policy, typ string) bool {
	typ = strings.ToLower(strings.TrimSpace(typ))
	if typ == "" {
		return false
	}
	if _, no := neverCommands[typ]; no {
		return false
	}
	for _, a := range defaultCommands {
		if a == typ {
			return true
		}
	}
	for _, a := range p.AllowCommands {
		if strings.ToLower(strings.TrimSpace(a)) == typ {
			return true
		}
	}
	return false
}

func LoadPolicy(dataDir string) Policy {
	raw, err := os.ReadFile(filepath.Join(dataDir, policyFile))
	if err != nil {
		return DefaultPolicy()
	}
	var p Policy
	if json.Unmarshal(raw, &p) != nil {
		return DefaultPolicy()
	}
	if p.AllowCommands == nil {
		p.AllowCommands = []string{}
	}
	return p
}

func StorePolicy(dataDir string, p Policy) error {
	if p.AllowCommands == nil {
		p.AllowCommands = []string{}
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return writeRestricted(filepath.Join(dataDir, policyFile), raw, 0o644)
}

const crlFile = "mesh-crl.json"

func LoadCRL(dataDir string) map[string]struct{} {
	out := map[string]struct{}{}
	raw, err := os.ReadFile(filepath.Join(dataDir, crlFile))
	if err != nil {
		return out
	}
	var serials []string
	if json.Unmarshal(raw, &serials) != nil {
		return out
	}
	for _, s := range serials {
		n := NormSerial(s)
		if n != "" && n != "0" {
			out[n] = struct{}{}
		}
	}
	return out
}

func StoreCRL(dataDir string, serials []string) error {
	if serials == nil {
		serials = []string{}
	}
	raw, err := json.Marshal(serials)
	if err != nil {
		return err
	}
	return writeRestricted(filepath.Join(dataDir, crlFile), raw, 0o644)
}
