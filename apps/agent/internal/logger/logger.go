package logger

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	maxPending    = 200
	maxLogBytes   = 5 << 20
	rotatedSuffix = ".1"
)

type AgentLog struct {
	*log.Logger
	mu      sync.Mutex
	pending []map[string]any
}

type rotatingWriter struct {
	mu   sync.Mutex
	path string
	file *os.File
	size int64
}

func (w *rotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return 0, os.ErrClosed
	}
	if w.size+int64(len(p)) > maxLogBytes {
		_ = w.file.Close()
		_ = os.Rename(w.path, w.path+rotatedSuffix)
		f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			w.file = nil
			return 0, err
		}
		w.file = f
		w.size = 0
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

func Setup(dataDir string) *AgentLog {
	_ = os.MkdirAll(dataDir, 0o755)
	path := filepath.Join(dataDir, "agent.log")
	var w io.Writer = os.Stderr
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err == nil {
		st, _ := f.Stat()
		rot := &rotatingWriter{path: path, file: f, size: st.Size()}
		w = io.MultiWriter(rot, os.Stderr)
	}
	return &AgentLog{Logger: log.New(w, "", log.LstdFlags)}
}

func (a *AgentLog) Note(level, msg string) {
	a.Printf("%s", msg)
	if level != "DEBUG" && level != "INFO" && level != "WARNING" && level != "ERROR" {
		level = "INFO"
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.pending = append(a.pending, map[string]any{
		"level":     level,
		"source":    "agent",
		"message":   msg,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
	if len(a.pending) > maxPending {
		a.pending = a.pending[len(a.pending)-maxPending:]
	}
}

func (a *AgentLog) Notef(level, format string, args ...any) {
	a.Note(level, fmt.Sprintf(format, args...))
}

func (a *AgentLog) Drain() []map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := a.pending
	a.pending = nil
	return out
}

func (a *AgentLog) Restore(entries []map[string]any) {
	if len(entries) == 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.pending = append(entries, a.pending...)
	if len(a.pending) > maxPending {
		a.pending = a.pending[len(a.pending)-maxPending:]
	}
}
