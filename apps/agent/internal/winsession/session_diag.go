package winsession

// InteractiveSession describes the desktop session the agent would impersonate.
type InteractiveSession struct {
	SessionID       uint32 `json:"sessionId,omitempty"`
	Username        string `json:"username,omitempty"`
	State           string `json:"sessionState,omitempty"`
	ImpersonationOk bool   `json:"impersonationOk"`
}
