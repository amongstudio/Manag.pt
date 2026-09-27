package shell

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/pc-manager/agent/internal/logger"
	"github.com/pc-manager/agent/internal/wsprotocol"
)

type Sender func(v any)

type Manager struct {
	log        *logger.AgentLog
	send       Sender
	mu         sync.Mutex
	sess       *Session
	execCancel context.CancelFunc
	execGen    uint64
}

func New(log *logger.AgentLog, send Sender) *Manager {
	return &Manager{log: log, send: send}
}

func (m *Manager) Handle(typ string, payload json.RawMessage, bin []byte) {
	if m == nil {
		return
	}
	switch typ {
	case wsprotocol.TypeShellOpen:
		m.open(ParseOpen(payload))
	case wsprotocol.TypeShellData:
		data := bin
		if len(data) == 0 {
			var frame wsprotocol.ShellData
			_ = json.Unmarshal(payload, &frame)
			data = []byte(frame.Data)
		}
		m.write(data)
	case wsprotocol.TypeShellResize:
		cols, rows := ParseResize(payload)
		m.resize(cols, rows)
	case wsprotocol.TypeShellClose:
		m.Close()
	case wsprotocol.TypeShellExec:
		go m.exec(ParseExec(payload))
	}
}

func (m *Manager) open(req OpenRequest) {
	m.mu.Lock()
	if m.sess != nil {
		m.sess.Close()
		m.sess = nil
	}
	sess, err := Open(req.Shell, req.Cols, req.Rows)
	if err != nil {
		m.mu.Unlock()
		if m.log != nil {
			m.log.Notef("WARNING", "shell_open: %v", err)
		}
		m.emitClose(errReason(err))
		return
	}
	m.sess = sess
	m.mu.Unlock()
	go m.pump(sess)
}

func (m *Manager) write(p []byte) {
	m.mu.Lock()
	sess := m.sess
	m.mu.Unlock()
	if sess == nil || len(p) == 0 {
		return
	}
	_, _ = sess.Write(p)
}

func (m *Manager) resize(cols, rows int) {
	m.mu.Lock()
	sess := m.sess
	m.mu.Unlock()
	if sess == nil {
		return
	}
	_ = sess.Resize(cols, rows)
}

func (m *Manager) Close() {
	m.mu.Lock()
	sess := m.sess
	m.sess = nil
	m.mu.Unlock()
	if sess != nil {
		sess.Close()
	}
}

func (m *Manager) pump(sess *Session) {
	for b := range sess.Output() {
		if len(b) == 0 {
			continue
		}
		if m.send != nil {
			m.send(wsprotocol.ShellData{Type: wsprotocol.TypeShellData, Data: string(b)})
		}
	}
	reason := ReasonExit
	if sess.Err() != nil {
		reason = errReason(sess.Err())
	}
	m.mu.Lock()
	if m.sess == sess {
		m.sess = nil
	}
	m.mu.Unlock()
	m.emitClose(reason)
}

func (m *Manager) emitClose(reason string) {
	if m.send == nil {
		return
	}
	m.send(wsprotocol.ShellClose{Type: wsprotocol.TypeShellClose, Reason: reason})
}

func errReason(err error) string {
	if err == nil {
		return ReasonExit
	}
	if IsUnsupported(err) {
		return ReasonUnsupported
	}
	if IsNoSession(err) {
		return ReasonNoInteractiveSession
	}
	return err.Error()
}
