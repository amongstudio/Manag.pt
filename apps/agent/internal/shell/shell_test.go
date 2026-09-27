package shell

import (
	"strings"
	"testing"

	"github.com/pc-manager/agent/internal/wsprotocol"
)

func TestParseOpenDefaults(t *testing.T) {
	req := ParseOpen([]byte(`{}`))
	if req.Shell != KindPowerShell || req.Cols != 120 || req.Rows != 40 {
		t.Fatalf("%+v", req)
	}
	req = ParseOpen([]byte(`{"shell":"cmd","cols":80,"rows":24}`))
	if req.Shell != KindCmd || req.Cols != 80 {
		t.Fatalf("%+v", req)
	}
}

func TestOpenUnsupportedOnThisOS(t *testing.T) {
	if Supported() {
		t.Skip("windows")
	}
	_, err := Open(KindPowerShell, 80, 24)
	if !IsUnsupported(err) {
		t.Fatalf("err=%v", err)
	}
}

func TestParseExec(t *testing.T) {
	req := ParseExec([]byte(`{"id":"e1","command":"echo hi","shell":"cmd"}`))
	if req.ID != "e1" || req.Command != "echo hi" || req.Shell != KindCmd {
		t.Fatalf("%+v", req)
	}
	req = ParseExec([]byte(`{"id":" e2 ","command":"  dir  ","shell":"nope"}`))
	if req.ID != "e2" || req.Command != "dir" || req.Shell != "" {
		t.Fatalf("%+v", req)
	}
}

func TestExecEcho(t *testing.T) {
	var frames []wsprotocol.ShellExec
	m := New(nil, func(v any) {
		if frame, ok := v.(wsprotocol.ShellExec); ok {
			frames = append(frames, frame)
		}
	})
	m.exec(ExecRequest{ID: "t1", Command: "echo hello"})
	var out strings.Builder
	var done bool
	for _, frame := range frames {
		out.WriteString(frame.Data)
		if frame.Done {
			done = true
			if frame.ExitCode == nil || *frame.ExitCode != 0 {
				t.Fatalf("exit=%v frames=%+v", frame.ExitCode, frames)
			}
		}
	}
	if !done {
		t.Fatalf("missing done: %+v", frames)
	}
	if !strings.Contains(strings.ToLower(out.String()), "hello") {
		t.Fatalf("output=%q", out.String())
	}
}
