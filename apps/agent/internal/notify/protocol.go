package notify

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

const (
	PipeName = `\\.\pipe\pc-manager-notify`

	KindEnrolled        = "enrolled"
	KindWSDown          = "ws_down"
	KindWSUp            = "ws_up"
	KindUpdateApplied   = "update_applied"
	KindDesktopIncoming = "desktop_incoming"
	KindMeshPeer        = "mesh_peer"
	KindAgentRecovering = "agent_recovering"
	KindQuickAssist     = "quick_assist"

	maxMessageBytes = 8 << 10
)

var knownKinds = map[string]struct{}{
	KindEnrolled:        {},
	KindWSDown:          {},
	KindWSUp:            {},
	KindUpdateApplied:   {},
	KindDesktopIncoming: {},
	KindMeshPeer:        {},
	KindAgentRecovering: {},
	KindQuickAssist:     {},
}

// Message is one status toast. The service writes JSON {kind,title,body}
// (newline-terminated) to PipeName; the user-session tray shows a balloon.
type Message struct {
	Kind  string `json:"kind"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

func KnownKind(kind string) bool {
	_, ok := knownKinds[strings.TrimSpace(kind)]
	return ok
}

func DefaultTitle(kind string) string {
	switch strings.TrimSpace(kind) {
	case KindDesktopIncoming:
		return "Remote desktop"
	case KindQuickAssist:
		return "Quick Assist"
	default:
		return "Mnag.pt Agent"
	}
}

func DefaultBody(kind string) string {
	switch strings.TrimSpace(kind) {
	case KindEnrolled:
		return "This PC is enrolled."
	case KindWSDown:
		return "Connection to the server was lost."
	case KindWSUp:
		return "Connected to the server."
	case KindUpdateApplied:
		return "Agent update applied."
	case KindDesktopIncoming:
		return "Remote desktop session starting."
	case KindMeshPeer:
		return "A mesh peer connected."
	case KindAgentRecovering:
		return "Agent is recovering."
	case KindQuickAssist:
		return "Opened on the desktop."
	default:
		return ""
	}
}

func (m Message) Normalized() Message {
	m.Kind = strings.TrimSpace(m.Kind)
	m.Title = strings.TrimSpace(m.Title)
	m.Body = strings.TrimSpace(m.Body)
	if m.Title == "" {
		m.Title = DefaultTitle(m.Kind)
	}
	if m.Body == "" {
		m.Body = DefaultBody(m.Kind)
	}
	return m
}

func (m Message) Validate() error {
	if !KnownKind(m.Kind) {
		if strings.TrimSpace(m.Kind) == "" {
			return fmt.Errorf("notify: missing kind")
		}
		return fmt.Errorf("notify: unknown kind %q", m.Kind)
	}
	return nil
}

func WriteMessage(w io.Writer, msg Message) error {
	msg = msg.Normalized()
	if err := msg.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	if len(raw) > maxMessageBytes {
		return fmt.Errorf("notify message too large")
	}
	_, err = w.Write(append(raw, '\n'))
	return err
}

func ReadMessage(r io.Reader) (Message, error) {
	dec := json.NewDecoder(io.LimitReader(r, maxMessageBytes+1))
	var msg Message
	if err := dec.Decode(&msg); err != nil {
		return Message{}, err
	}
	msg = msg.Normalized()
	if err := msg.Validate(); err != nil {
		return Message{}, err
	}
	return msg, nil
}
