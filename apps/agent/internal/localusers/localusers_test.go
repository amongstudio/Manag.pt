package localusers

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidName(t *testing.T) {
	for _, ok := range []string{"Administrator", "svc.backup", "Jane Doe"} {
		if !ValidName(ok) {
			t.Fatalf("rejected %q", ok)
		}
	}
	for _, bad := range []string{`CORP\jane`, "jane@corp.local", "a/b", "..", "-admin", " padded", strings.Repeat("x", 21), "a*b", ""} {
		if ValidName(bad) {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestParseAction(t *testing.T) {
	if _, err := ParseAction(json.RawMessage(`{"username":"bob","action":"disable"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseAction(json.RawMessage(`{"username":"bob","action":"enable","password":"Secret123!"}`)); err == nil {
		t.Fatal("password accepted for enable")
	}
	if _, err := ParseAction(json.RawMessage(`{"username":"bob","action":"set_password","password":"short"}`)); err == nil {
		t.Fatal("short password accepted")
	}
	if _, err := ParseAction(json.RawMessage(`{"username":"bob","action":"delete"}`)); err == nil {
		t.Fatal("unknown action accepted")
	}
	if _, err := ParseAction(json.RawMessage(`{"username":"CORP\\bob","action":"disable"}`)); err == nil {
		t.Fatal("domain account accepted")
	}
}
