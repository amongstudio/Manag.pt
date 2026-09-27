package mesh

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const auditFile = "mesh-audit.jsonl"

type AuditEntry struct {
	TS       string `json:"ts"`
	Op       string `json:"op"`
	PeerID   string `json:"peerId"`
	Path     string `json:"path,omitempty"`
	CmdType  string `json:"cmdType,omitempty"`
	ResultID string `json:"resultId,omitempty"`
	Size     int64  `json:"size,omitempty"`
	SHA256   string `json:"sha256,omitempty"`
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
}

type Audit struct {
	mu      sync.Mutex
	dataDir string
}

func NewAudit(dataDir string) *Audit {
	return &Audit{dataDir: dataDir}
}

func (a *Audit) Path() string {
	return filepath.Join(a.dataDir, auditFile)
}

func (a *Audit) Append(e AuditEntry) {
	if a == nil {
		return
	}
	if e.TS == "" {
		e.TS = time.Now().UTC().Format(time.RFC3339)
	}
	raw, err := json.Marshal(e)
	if err != nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	f, err := os.OpenFile(a.Path(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	_, _ = f.Write(append(raw, '\n'))
	_ = f.Close()
}

func (a *Audit) Drain() []map[string]any {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.Path()
	f, err := os.Open(p)
	if err != nil {
		return nil
	}
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		s := sc.Text()
		if s != "" {
			lines = append(lines, s)
		}
	}
	_ = f.Close()
	_ = os.Remove(p)
	if len(lines) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(lines))
	now := time.Now().UTC().Format(time.RFC3339)
	for _, line := range lines {
		out = append(out, map[string]any{
			"level":     "INFO",
			"source":    "mesh",
			"message":   line,
			"timestamp": now,
		})
	}
	return out
}

func (a *Audit) Restore(entries []map[string]any) {
	if a == nil || len(entries) == 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	existing, _ := os.ReadFile(a.Path())
	var b strings.Builder
	for _, e := range entries {
		msg, _ := e["message"].(string)
		if strings.TrimSpace(msg) == "" {
			continue
		}
		b.WriteString(msg)
		if !strings.HasSuffix(msg, "\n") {
			b.WriteByte('\n')
		}
	}
	b.Write(existing)
	_ = os.WriteFile(a.Path(), []byte(b.String()), 0o644)
}
