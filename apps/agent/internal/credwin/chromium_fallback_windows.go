//go:build windows

package credwin

import (
	"os"
	"strings"
)

// readChromiumLoginsFallback mirrors Python Browser.py: copy Login Data, read
// action_url/username_value/password_value, then decrypt with the master key.
func readChromiumLoginsFallback(dbPath string, key []byte, reveal bool) []Credential {
	tmp, err := os.CreateTemp("", "pcmgr-logins-fb-*.db")
	if err != nil {
		return nil
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)
	if err := copyLoginDB(dbPath, tmpPath); err != nil {
		return nil
	}

	// Python tooling typically queries action_url (older Chrome builds).
	rows := scanSqliteTableWithBlobs(tmpPath, "logins",
		[]string{"action_url", "username_value", "password_value", "date_created", "date_last_used", "date_password_modified"},
		[]string{"password_value"},
	)
	if len(rows) == 0 {
		rows = scanSqliteTableWithBlobs(tmpPath, "logins",
			[]string{"origin_url", "username_value", "password_value"},
			[]string{"password_value"},
		)
	}
	out := make([]Credential, 0, len(rows))
	for _, row := range rows {
		url := strings.TrimSpace(row["action_url"])
		if url == "" {
			url = strings.TrimSpace(row["origin_url"])
		}
		user := strings.TrimSpace(row["username_value"])
		if url == "" && user == "" {
			continue
		}
		c := Credential{
			Key:      browserCredKey("", "", url, user),
			Source:   "browser",
			Kind:     "password",
			Target:   url,
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
