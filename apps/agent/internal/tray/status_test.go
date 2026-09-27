package tray

import "testing"

func TestFormatStatus(t *testing.T) {
	cases := []struct {
		in   Snapshot
		want string
	}{
		{Snapshot{}, "Not installed as service"},
		{Snapshot{Installed: true}, "Agent not running"},
		{Snapshot{Installed: true, Running: true}, "Not enrolled"},
		{Snapshot{Installed: true, Running: true, Enrolled: true}, "Enrolled · WS down"},
		{Snapshot{Installed: true, Running: true, Enrolled: true, WS: true}, "Enrolled · WS connected"},
		{Snapshot{Installed: true, Running: true, LastError: "enroll failed: no secret"}, "Not enrolled · enroll failed: no secret"},
	}
	for _, tc := range cases {
		if got := Format(tc.in); got != tc.want {
			t.Fatalf("format(%+v)=%q want %q", tc.in, got, tc.want)
		}
	}
}

func TestTruncate(t *testing.T) {
	if truncate("abc", 10) != "abc" {
		t.Fatal("short")
	}
	if got := truncate("abcdefghij", 4); got != "abcd…" {
		t.Fatalf("got %q", got)
	}
}

func TestStatusURL(t *testing.T) {
	if statusURL(0) != "http://127.0.0.1:17890/status" {
		t.Fatal(statusURL(0))
	}
	if statusURL(9) != "http://127.0.0.1:9/status" {
		t.Fatal(statusURL(9))
	}
}
