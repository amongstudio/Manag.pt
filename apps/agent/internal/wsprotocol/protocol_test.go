package wsprotocol

import (
	"encoding/json"
	"testing"
)

func TestShellFrameRoundTrip(t *testing.T) {
	open := ShellOpen{Type: TypeShellOpen, Shell: "powershell", Cols: 120, Rows: 40}
	raw, err := json.Marshal(open)
	if err != nil {
		t.Fatal(err)
	}
	var back ShellOpen
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if back.Shell != "powershell" || back.Cols != 120 {
		t.Fatalf("open=%+v", back)
	}

	data := ShellData{Type: TypeShellData, Data: "PS> "}
	raw, err = json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	var d ShellData
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	if d.Data != "PS> " {
		t.Fatalf("data=%q", d.Data)
	}

	close := ShellClose{Type: TypeShellClose, Reason: "unsupported"}
	raw, err = json.Marshal(close)
	if err != nil {
		t.Fatal(err)
	}
	var c ShellClose
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if c.Reason != "unsupported" {
		t.Fatalf("close=%+v", c)
	}

	code := 0
	exec := ShellExec{Type: TypeShellExec, ID: "e1", Command: "echo hi", Done: true, ExitCode: &code}
	raw, err = json.Marshal(exec)
	if err != nil {
		t.Fatal(err)
	}
	var e ShellExec
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatal(err)
	}
	if e.ID != "e1" || e.Command != "echo hi" || e.ExitCode == nil || *e.ExitCode != 0 {
		t.Fatalf("exec=%+v", e)
	}
}

func TestPresenceHeartbeatOmitsMetrics(t *testing.T) {
	raw, err := json.Marshal(Heartbeat{Type: TypeHeartbeat})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["cpu"]; ok {
		t.Fatalf("cpu should be omitted: %s", raw)
	}
	if m["type"] != TypeHeartbeat {
		t.Fatalf("type=%v", m["type"])
	}
}

func TestEncodeBinaryShellData(t *testing.T) {
	frame, err := EncodeBinary(BinShellData, map[string]string{"type": TypeShellData}, []byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	binType, _, payload, err := DecodeBinary(frame)
	if err != nil {
		t.Fatal(err)
	}
	if binType != BinShellData || string(payload) != "hi" {
		t.Fatalf("bin=%d payload=%q", binType, payload)
	}
}
