package shell

import "encoding/json"

const (
	KindPowerShell             = "powershell"
	KindCmd                    = "cmd"
	KindSh                     = "sh"
	ReasonUnsupported          = "unsupported"
	ReasonNoInteractiveSession = "no_interactive_session"
	ReasonExit                 = "exit"
	ReasonReplaced             = "replaced"
	ExecTimeout                = 60
	ExecOutputMax              = 262144
)

type OpenRequest struct {
	Shell string `json:"shell"`
	Cols  int    `json:"cols"`
	Rows  int    `json:"rows"`
}

func ParseOpen(raw json.RawMessage) OpenRequest {
	var req OpenRequest
	_ = json.Unmarshal(raw, &req)
	if req.Cols < 1 {
		req.Cols = 120
	}
	if req.Rows < 1 {
		req.Rows = 40
	}
	if req.Cols > 400 {
		req.Cols = 400
	}
	if req.Rows > 200 {
		req.Rows = 200
	}
	switch req.Shell {
	case KindCmd:
	default:
		req.Shell = KindPowerShell
	}
	return req
}

func ParseResize(raw json.RawMessage) (cols, rows int) {
	var req struct {
		Cols int `json:"cols"`
		Rows int `json:"rows"`
	}
	_ = json.Unmarshal(raw, &req)
	return req.Cols, req.Rows
}
