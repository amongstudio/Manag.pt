//go:build lite

package desktop

import "github.com/pc-manager/agent/internal/logger"

type SignalPayload struct {
	Kind       string `json:"kind"`
	SDP        string `json:"sdp,omitempty"`
	SDPType    string `json:"sdpType,omitempty"`
	Candidate  any    `json:"candidate,omitempty"`
	AllowInput bool   `json:"allowInput,omitempty"`
	Encrypted  bool   `json:"encrypted,omitempty"`
	Error      string `json:"error,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

type Sender func(payload SignalPayload)

type Session struct {
	send Sender
}

func New(_ *logger.AgentLog, send Sender, _ string) *Session {
	return &Session{send: send}
}

func RegisterCaptureHelperH264() {}

func (s *Session) Handle(_ []byte) {
	if s != nil && s.send != nil {
		s.send(SignalPayload{Kind: "hangup", Error: "webrtc_unavailable", Reason: "webrtc_unavailable"})
	}
}

func (s *Session) Close() {}
