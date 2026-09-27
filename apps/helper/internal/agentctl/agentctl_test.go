package agentctl

import "testing"

func TestNew(t *testing.T) {
	c := New("PCManagerAgent")
	if c == nil {
		t.Fatal("New returned nil")
	}
}
