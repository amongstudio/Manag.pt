//go:build windows

package credwin

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func appFileCredentials(reveal bool) []Credential {
	var out []Credential
	for _, root := range userProfileRoots() {
		out = append(out, gitFileCredentials(root, reveal)...)
		out = append(out, npmFileCredentials(root, reveal)...)
		out = append(out, dockerFileCredentials(root, reveal)...)
		if len(out) >= maxCreds {
			return out[:maxCreds]
		}
	}
	return out
}

func gitFileCredentials(root string, reveal bool) []Credential {
	raw, err := os.ReadFile(filepath.Join(root, ".git-credentials"))
	if err != nil {
		return nil
	}
	var out []Credential
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		u, err := url.Parse(line)
		if err != nil || u.Host == "" {
			continue
		}
		user := ""
		secret := ""
		if u.User != nil {
			user = u.User.Username()
			secret, _ = u.User.Password()
		}
		target := "git:" + u.Scheme + "://" + u.Host + u.Path
		c := Credential{
			Key:     CredKey("apps", target, user),
			Source:  "apps",
			Kind:    "password",
			Target:  target,
			Username: user,
			Comment: "Git credential file (~/.git-credentials)",
			Store:   "file",
		}
		if reveal {
			c.Secret = secret
			if c.Secret == "" {
				c.Locked = true
			}
		}
		out = append(out, c)
	}
	return out
}

func npmFileCredentials(root string, reveal bool) []Credential {
	paths := []string{
		filepath.Join(root, ".npmrc"),
		filepath.Join(root, "AppData", "Roaming", "npm", ".npmrc"),
	}
	var out []Credential
	seen := map[string]bool{}
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
				continue
			}
			key, val, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			key = strings.TrimSpace(key)
			val = strings.TrimSpace(val)
			if !strings.Contains(strings.ToLower(key), "auth") && !strings.Contains(strings.ToLower(key), "token") && !strings.Contains(strings.ToLower(key), "_password") {
				continue
			}
			target := "npm:" + key
			if seen[target] {
				continue
			}
			seen[target] = true
			c := Credential{
				Key:     CredKey("apps", target, ""),
				Source:  "apps",
				Kind:    "token",
				Target:  target,
				Comment: "npmrc token (file store)",
				Store:   "file",
			}
			if reveal {
				c.Secret = strings.Trim(val, `"'`)
			}
			out = append(out, c)
		}
	}
	return out
}

func dockerFileCredentials(root string, reveal bool) []Credential {
	raw, err := os.ReadFile(filepath.Join(root, ".docker", "config.json"))
	if err != nil {
		return nil
	}
	var body struct {
		Auths map[string]struct {
			Auth     string `json:"auth"`
			Username string `json:"username"`
			Password string `json:"password"`
		} `json:"auths"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return nil
	}
	var out []Credential
	for host, auth := range body.Auths {
		host = strings.TrimSpace(host)
		if host == "" {
			continue
		}
		user := strings.TrimSpace(auth.Username)
		secret := auth.Password
		if auth.Auth != "" {
			dec, err := base64.StdEncoding.DecodeString(auth.Auth)
			if err == nil {
				if u, p, ok := strings.Cut(string(dec), ":"); ok {
					if user == "" {
						user = u
					}
					if secret == "" {
						secret = p
					}
				}
			}
		}
		target := "docker:" + host
		c := Credential{
			Key:      CredKey("apps", target, user),
			Source:   "apps",
			Kind:     "password",
			Target:   target,
			Username: user,
			Comment:  "Docker config.json auth (file store)",
			Store:    "file",
		}
		if reveal {
			c.Secret = secret
			if c.Secret == "" {
				c.Locked = true
			}
		}
		out = append(out, c)
	}
	return out
}
