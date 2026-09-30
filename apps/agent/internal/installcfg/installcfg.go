// Package installcfg is the install-parameter contract shared with
// apps/agent/installer/pc-manager.iss and install.ps1. The Inno script writes
// config.yaml and then runs the agent binary's own install/start commands.
package installcfg

import (
	"fmt"
	"strings"
)

// Args is the silent-install parameter set. /VERYSILENT is Inno Setup's switch.
type Args struct {
	Server     string
	Secret     string
	VerySilent bool
}

// Parse reads /SERVER=, /SECRET=, and /VERYSILENT the way Inno Setup forwards
// them on a setup command line. Unknown arguments are ignored.
func Parse(argv []string) (Args, error) {
	out := Args{Server: "http://localhost:4000", Secret: "change-me-enrollment-secret"}
	for _, raw := range argv {
		item := strings.TrimSpace(raw)
		if item == "" {
			continue
		}
		upper := strings.ToUpper(item)
		switch {
		case upper == "/VERYSILENT" || upper == "-VERYSILENT":
			out.VerySilent = true
		case strings.HasPrefix(upper, "/SERVER=") || strings.HasPrefix(upper, "-SERVER="):
			out.Server = strings.TrimSpace(item[strings.Index(item, "=")+1:])
		case strings.HasPrefix(upper, "/SECRET=") || strings.HasPrefix(upper, "-SECRET="):
			out.Secret = strings.TrimSpace(item[strings.Index(item, "=")+1:])
		}
	}
	if out.Server == "" {
		return Args{}, fmt.Errorf("empty server")
	}
	if strings.ContainsAny(out.Server, "\r\n") || strings.ContainsAny(out.Secret, "\r\n") {
		return Args{}, fmt.Errorf("invalid characters")
	}
	return out, nil
}

func yamlQuote(value string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range value {
		switch r {
		case '\\', '"':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\r':
			b.WriteString(`\r`)
		case '\n':
			b.WriteString(`\n`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// DefaultYAML is the config written when Program Files has no config.yaml yet.
// Intervals match install.ps1 (heartbeat 30, poll 15, status 17890).
func DefaultYAML(server, secret string) string {
	return strings.Join([]string{
		"server_url: " + yamlQuote(server),
		"fallback_urls: []",
		"enrollment_secret: " + yamlQuote(secret),
		"heartbeat_interval_sec: 30",
		"poll_interval_sec: 15",
		"status_port: 17890",
		"",
	}, "\n")
}
