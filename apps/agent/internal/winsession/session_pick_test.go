package winsession

import "testing"

func TestSessionStatePriority(t *testing.T) {
	if sessionStatePriority(wtsActive) >= sessionStatePriority(wtsDisconnected) {
		t.Fatal("active should beat disconnected")
	}
	if sessionStatePriority(wtsDisconnected) >= sessionStatePriority(wtsConnected) {
		t.Fatal("disconnected should beat connected")
	}
	if sessionStatePriority(5) >= 0 {
		t.Fatal("idle should not be interactive")
	}
}

func TestPickBestSession(t *testing.T) {
	cands := []sessionCandidate{
		{id: 2, state: wtsDisconnected, username: "alice"},
		{id: 3, state: wtsActive, username: "bob"},
		{id: 1, state: wtsActive, username: "carol"},
	}
	best, ok := pickBestSession(cands)
	if !ok || best.id != 1 || best.username != "carol" {
		t.Fatalf("expected lowest active session, got %+v ok=%v", best, ok)
	}
	disconnected, ok := pickBestSession([]sessionCandidate{
		{id: 4, state: wtsDisconnected, username: "rdp-user"},
		{id: 0, state: wtsActive, username: ""},
	})
	if !ok || disconnected.id != 4 {
		t.Fatalf("expected disconnected RDP session, got %+v ok=%v", disconnected, ok)
	}
}

func TestSessionStateName(t *testing.T) {
	if sessionStateName(wtsActive) != "active" {
		t.Fatal(sessionStateName(wtsActive))
	}
	if sessionStateName(wtsDisconnected) != "disconnected" {
		t.Fatal(sessionStateName(wtsDisconnected))
	}
}
