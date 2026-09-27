package tray

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Options struct {
	Version    string
	StatusPort int
	DataDir    string
}

type Snapshot struct {
	Running    bool
	Enrolled   bool
	WS         bool
	LastError  string
	DeviceID   string
	Version    string
	Installed  bool
	InstallErr string
}

func Format(s Snapshot) string {
	if !s.Installed {
		if s.InstallErr != "" {
			return "Not installed · " + truncate(s.InstallErr, 48)
		}
		return "Not installed as service"
	}
	if !s.Running {
		if s.LastError != "" {
			return "Stopped · " + truncate(s.LastError, 40)
		}
		return "Agent not running"
	}
	if !s.Enrolled {
		if s.LastError != "" {
			return "Not enrolled · " + truncate(s.LastError, 40)
		}
		return "Not enrolled"
	}
	if s.WS {
		return "Enrolled · WS connected"
	}
	return "Enrolled · WS down"
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if n <= 0 || len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func statusURL(port int) string {
	if port <= 0 {
		port = 17890
	}
	return fmt.Sprintf("http://127.0.0.1:%d/status", port)
}

func tokenCandidates(dataDir string) []string {
	var out []string
	add := func(p string) {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	if dataDir != "" {
		add(filepath.Join(dataDir, "status.token"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Join(home, ".pc-manager", "status.token"))
	}
	if pd := os.Getenv("ProgramData"); pd != "" {
		add(filepath.Join(pd, "PC Manager Agent", "status.token"))
	}
	return out
}

func readToken(dataDir string) string {
	for _, p := range tokenCandidates(dataDir) {
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if tok := strings.TrimSpace(string(raw)); tok != "" {
			return tok
		}
	}
	return ""
}

type statusBody struct {
	DeviceID    string `json:"deviceId"`
	Version     string `json:"version"`
	WSConnected bool   `json:"wsConnected"`
	Enrolled    *bool  `json:"enrolled"`
	LastError   string `json:"lastError"`
}

func Fetch(ctx context.Context, port int, dataDir string) Snapshot {
	snap := Snapshot{}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, statusURL(port), nil)
	if err != nil {
		snap.LastError = err.Error()
		return snap
	}
	if tok := readToken(dataDir); tok != "" {
		req.Header.Set("X-Status-Token", tok)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		snap.LastError = err.Error()
		return snap
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 8192))
	if res.StatusCode == http.StatusUnauthorized {
		snap.Running = true
		snap.LastError = "status unauthorized"
		return snap
	}
	if res.StatusCode != http.StatusOK {
		snap.LastError = fmt.Sprintf("status %d", res.StatusCode)
		return snap
	}
	var body statusBody
	if err := json.Unmarshal(raw, &body); err != nil {
		snap.Running = true
		snap.LastError = "bad status json"
		return snap
	}
	snap.Running = true
	snap.DeviceID = body.DeviceID
	snap.Version = body.Version
	snap.WS = body.WSConnected
	snap.LastError = body.LastError
	if body.Enrolled != nil {
		snap.Enrolled = *body.Enrolled
	} else {
		snap.Enrolled = body.DeviceID != ""
	}
	return snap
}

func FetchNow(port int, dataDir string) Snapshot {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return Fetch(ctx, port, dataDir)
}
