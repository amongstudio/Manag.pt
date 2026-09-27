package winops

import (
	"strconv"
	"strings"
)

func parseManageBde(raw string) []BitLockerVolume {
	blocks := splitManageBdeVolumes(raw)
	out := make([]BitLockerVolume, 0, len(blocks))
	for _, block := range blocks {
		vol := parseManageBdeBlock(block)
		if vol.MountPoint == "" && vol.DeviceID == "" {
			continue
		}
		out = append(out, vol)
	}
	return out
}

func splitManageBdeVolumes(raw string) []string {
	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	var blocks []string
	var cur []string
	flush := func() {
		if len(cur) == 0 {
			return
		}
		blocks = append(blocks, strings.Join(cur, "\n"))
		cur = nil
	}
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(strings.ToLower(trim), "volume ") && strings.Contains(trim, ":") {
			flush()
		}
		if trim == "" && len(cur) == 0 {
			continue
		}
		cur = append(cur, line)
	}
	flush()
	return blocks
}

func parseManageBdeBlock(block string) BitLockerVolume {
	vol := BitLockerVolume{ProtectionStatus: "unknown"}
	inProtectors := false
	for _, line := range strings.Split(block, "\n") {
		trim := strings.TrimSpace(line)
		lower := strings.ToLower(trim)
		if strings.HasPrefix(lower, "volume ") {
			rest := strings.TrimSpace(trim[len("Volume "):])
			label := ""
			if i := strings.Index(rest, "["); i >= 0 {
				label = strings.Trim(rest[i:], "[]")
				rest = strings.TrimSpace(rest[:i])
			}
			if i := strings.Index(rest, " "); i > 0 {
				rest = rest[:i]
			}
			vol.MountPoint = strings.Trim(rest, "[]")
			if label != "" {
				vol.VolumeType = manageBdeVolumeType(label)
			}
			inProtectors = false
			continue
		}
		if strings.HasPrefix(lower, "key protectors") {
			inProtectors = true
			if _, val, ok := cutKeyVal(trim); ok && val != "" && !strings.EqualFold(val, "none") && !strings.EqualFold(val, "none found") {
				vol.KeyProtectors = append(vol.KeyProtectors, parseProtectorLine(val)...)
			}
			continue
		}
		if inProtectors {
			if trim == "" {
				continue
			}
			if strings.HasPrefix(lower, "id:") || looksRecoveryPassword(trim) {
				continue
			}
			if strings.Contains(trim, ":") && indentLevel(line) < 8 && !isProtectorHeader(lower) {
				key, val, ok := cutKeyVal(trim)
				if ok {
					inProtectors = false
					applyManageBdeField(&vol, key, val)
				}
				continue
			}
			if p := parseProtectorLine(strings.TrimSuffix(trim, ":")); len(p) > 0 {
				vol.KeyProtectors = append(vol.KeyProtectors, p...)
			}
			continue
		}
		key, val, ok := cutKeyVal(trim)
		if !ok {
			continue
		}
		applyManageBdeField(&vol, key, val)
	}
	return vol
}

func indentLevel(line string) int {
	n := 0
	for _, r := range line {
		if r == ' ' {
			n++
			continue
		}
		if r == '\t' {
			n += 4
			continue
		}
		break
	}
	return n
}

func applyManageBdeField(vol *BitLockerVolume, key, val string) {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "protection status":
		vol.ProtectionStatus = manageBdeProtection(val)
	case "conversion status":
		vol.ConversionStatus = manageBdeConversion(val)
	case "encryption method":
		vol.EncryptionMethod = strings.ToLower(strings.ReplaceAll(val, " ", "_"))
	case "lock status":
		vol.LockStatus = manageBdeLock(val)
	case "automatic unlock":
		on := strings.Contains(strings.ToLower(val), "on") || strings.Contains(strings.ToLower(val), "enabled")
		off := strings.Contains(strings.ToLower(val), "off") || strings.Contains(strings.ToLower(val), "disabled")
		if on && !off {
			t := true
			vol.AutoUnlock = &t
		} else if off {
			f := false
			vol.AutoUnlock = &f
		}
	case "encryption flags", "wipe after decryption":
		vol.EncryptionFlags = manageBdeFlags(val)
	case "percentage encrypted":
		n := strings.TrimSuffix(strings.TrimSpace(strings.Split(val, "%")[0]), ".0")
		if pct, err := strconv.Atoi(strings.TrimSpace(n)); err == nil && pct >= 0 && pct <= 100 {
			vol.EncryptionPercent = &pct
		} else if f, err := strconv.ParseFloat(strings.TrimSpace(strings.Split(val, "%")[0]), 64); err == nil {
			p := int(f)
			if p >= 0 && p <= 100 {
				vol.EncryptionPercent = &p
			}
		}
	}
}

func manageBdeLock(v string) string {
	s := strings.ToLower(v)
	switch {
	case strings.Contains(s, "unlocked"):
		return "unlocked"
	case strings.Contains(s, "locked"):
		return "locked"
	default:
		return strings.TrimSpace(s)
	}
}

func manageBdeFlags(v string) string {
	s := strings.ToLower(v)
	if strings.Contains(s, "used space") {
		return "used_space"
	}
	if strings.Contains(s, "full") || strings.Contains(s, "entire") {
		return "full"
	}
	return ""
}

func manageBdeVolumeType(v string) string {
	s := strings.ToLower(strings.TrimSpace(v))
	switch {
	case s == "os" || strings.Contains(s, "osdisk") || strings.Contains(s, "operating"):
		return "os"
	case strings.Contains(s, "data"):
		return "data"
	default:
		return s
	}
}

func parseProtectorLine(val string) []BitLockerKeyProtector {
	s := strings.TrimSpace(val)
	if s == "" || strings.EqualFold(s, "none") || strings.HasSuffix(s, ":") && len(s) < 4 {
		s = strings.TrimSuffix(s, ":")
	}
	if s == "" || strings.EqualFold(s, "none") || strings.EqualFold(s, "none found") {
		return nil
	}
	typ := protectorTypeName(s)
	if typ == "" {
		return nil
	}
	return []BitLockerKeyProtector{{Type: typ}}
}

func protectorTypeName(v string) string {
	s := strings.ToLower(strings.TrimSpace(strings.TrimSuffix(v, ":")))
	switch {
	case s == "tpm" || strings.Contains(s, "trusted platform"):
		return "tpm"
	case strings.Contains(s, "tpm and pin") || strings.Contains(s, "tpmandpin"):
		return "tpm_pin"
	case strings.Contains(s, "numerical") || strings.Contains(s, "recovery password"):
		return "recovery"
	case strings.Contains(s, "passphrase") || s == "password":
		return "password"
	case strings.Contains(s, "startup key") || strings.Contains(s, "external"):
		return "startup_key"
	case strings.Contains(s, "public key") || strings.Contains(s, "certificate"):
		return "certificate"
	case strings.Contains(s, "sid"):
		return "sid"
	default:
		if strings.Contains(s, "{") {
			return ""
		}
		if s == "id" || s == "password" {
			return ""
		}
		return strings.ReplaceAll(s, " ", "_")
	}
}

func isProtectorHeader(lower string) bool {
	return strings.HasPrefix(lower, "tpm") ||
		strings.HasPrefix(lower, "numerical") ||
		strings.HasPrefix(lower, "password") ||
		strings.HasPrefix(lower, "passphrase") ||
		strings.HasPrefix(lower, "startup") ||
		strings.HasPrefix(lower, "external") ||
		strings.HasPrefix(lower, "public") ||
		strings.HasPrefix(lower, "certificate") ||
		strings.HasPrefix(lower, "sid")
}

func looksRecoveryPassword(v string) bool {
	s := strings.ReplaceAll(strings.TrimSpace(v), " ", "")
	n := 0
	for _, r := range s {
		if r == '-' {
			continue
		}
		if r < '0' || r > '9' {
			return false
		}
		n++
	}
	return n == 48
}

type recoveryProtector struct {
	Mount string
	ID    string
	Pass  string
}

func parseRecoveryProtectors(raw string) []recoveryProtector {
	var out []recoveryProtector
	var cur recoveryProtector
	flush := func() {
		if cur.Mount != "" && cur.Pass != "" {
			out = append(out, cur)
		}
		cur.ID = ""
		cur.Pass = ""
	}
	nextIsPass := false
	for _, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		trim := strings.TrimSpace(line)
		lower := strings.ToLower(trim)
		if strings.HasPrefix(lower, "volume ") {
			flush()
			rest := strings.TrimSpace(trim[len("Volume "):])
			if i := strings.Index(rest, " "); i > 0 {
				rest = rest[:i]
			}
			cur = recoveryProtector{Mount: strings.Trim(rest, "[]")}
			nextIsPass = false
			continue
		}
		if key, val, ok := cutKeyVal(trim); ok && strings.EqualFold(key, "id") {
			cur.ID = val
			nextIsPass = false
			continue
		}
		if strings.HasPrefix(lower, "password:") {
			if _, val, ok := cutKeyVal(trim); ok && looksRecoveryPassword(val) {
				cur.Pass = val
				nextIsPass = false
			} else {
				nextIsPass = true
			}
			continue
		}
		if nextIsPass && looksRecoveryPassword(trim) {
			cur.Pass = trim
			nextIsPass = false
		}
	}
	flush()
	return out
}

func cutKeyVal(line string) (string, string, bool) {
	i := strings.Index(line, ":")
	if i <= 0 {
		return "", "", false
	}
	return strings.TrimSpace(line[:i]), strings.TrimSpace(line[i+1:]), true
}

func manageBdeProtection(v string) string {
	s := strings.ToLower(v)
	switch {
	case strings.Contains(s, "off"):
		return "off"
	case strings.Contains(s, "on"):
		return "on"
	default:
		return "unknown"
	}
}

func manageBdeConversion(v string) string {
	s := strings.ToLower(strings.TrimSpace(v))
	switch {
	case strings.Contains(s, "fully encrypted"):
		return "fully_encrypted"
	case strings.Contains(s, "fully decrypted"):
		return "fully_decrypted"
	case strings.Contains(s, "encryption in progress") || strings.Contains(s, "encrypting"):
		return "encryption_in_progress"
	case strings.Contains(s, "decryption in progress") || strings.Contains(s, "decrypting"):
		return "decryption_in_progress"
	case strings.Contains(s, "paused") && strings.Contains(s, "encrypt"):
		return "encryption_paused"
	case strings.Contains(s, "paused") && strings.Contains(s, "decrypt"):
		return "decryption_paused"
	default:
		return s
	}
}
