//go:build windows

package netwin

import (
	"strings"
	"time"
)

func firewallFromNetsh() []FirewallRule {
	out, err := runCmdEnglish(90*time.Second, system32("netsh.exe"), "advfirewall", "firewall", "show", "rule", "name=all")
	if (err != nil && out == "") || len(parseNetshRules(out)) == 0 {
		verbose, verr := runCmdEnglish(90*time.Second, system32("netsh.exe"), "advfirewall", "firewall", "show", "rule", "name=all", "verbose")
		if verr == nil || verbose != "" {
			out = verbose
		}
	}
	if out == "" {
		return nil
	}
	return parseNetshRules(out)
}

func firewallFromNetshProfiles() []FirewallProfile {
	out, err := runCmdEnglish(30*time.Second, system32("netsh.exe"), "advfirewall", "show", "allprofiles")
	if err != nil && out == "" {
		return nil
	}
	return parseNetshProfiles(out)
}

func firewallFromPowerShell() []FirewallRule {
	script := strings.Join([]string{
		"$ProgressPreference='SilentlyContinue'",
		"Get-NetFirewallRule -ErrorAction SilentlyContinue | Select-Object -First 1500 @{n='name';e={if($_.DisplayName){$_.DisplayName}else{$_.Name}}},@{n='description';e={$_.Description}},@{n='direction';e={if([string]$_.Direction -match 'Out'){'outbound'}else{'inbound'}}},@{n='action';e={if([string]$_.Action -match 'Block'){'block'}else{'allow'}}},@{n='enabled';e={[string]$_.Enabled -notmatch 'False|Disable|^0$'}},@{n='profiles';e={[string]$_.Profile}} | ConvertTo-Json -Compress",
	}, ";")
	raw, err := runHidden(90*time.Second, system32(`WindowsPowerShell\v1.0\powershell.exe`),
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	if err != nil && raw == "" {
		return nil
	}
	var rows []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Direction   string `json:"direction"`
		Action      string `json:"action"`
		Enabled     any    `json:"enabled"`
		Profiles    string `json:"profiles"`
	}
	if unmarshalJSONList(raw, &rows) != nil {
		return nil
	}
	out := make([]FirewallRule, 0, len(rows))
	for _, row := range rows {
		if strings.TrimSpace(row.Name) == "" {
			continue
		}
		rule := FirewallRule{
			Name:        row.Name,
			Description: clipText(row.Description, 160),
			Direction:   "inbound",
			Action:      "allow",
			Enabled:     psEnabled(row.Enabled),
			Protocol:    "any",
			Profiles:    netshProfiles(row.Profiles),
		}
		if strings.EqualFold(row.Direction, "outbound") || strings.EqualFold(row.Direction, "out") {
			rule.Direction = "outbound"
		}
		if strings.EqualFold(row.Action, "block") || strings.EqualFold(row.Action, "deny") {
			rule.Action = "block"
		}
		out = append(out, rule)
		if len(out) >= maxFirewall {
			break
		}
	}
	return out
}

func psEnabled(v any) bool {
	switch n := v.(type) {
	case bool:
		return n
	case float64:
		return n != 0
	case string:
		s := strings.ToLower(strings.TrimSpace(n))
		return s != "false" && s != "0" && s != "no" && s != "disabled"
	default:
		return true
	}
}
