//go:build windows

package capture

import (
	"io"
	"strings"
	"testing"
)

func TestHelperModeNeverNests(t *testing.T) {
	prev := helperMode
	helperMode = true
	t.Cleanup(func() { helperMode = prev })
	if useHelper() {
		t.Fatal("capture-helper must grab locally, not spawn another helper")
	}
}

func TestPipeSDDLDropsEveryone(t *testing.T) {
	sddl := pipeSDDL("")
	if strings.Contains(sddl, "WD") {
		t.Fatalf("everyone ACE still present: %s", sddl)
	}
	if !strings.Contains(sddl, "SY") || !strings.Contains(sddl, "BA") {
		t.Fatalf("expected SYSTEM+Admin: %s", sddl)
	}
	withUser := pipeSDDL("S-1-5-21-1-2-3-1001")
	if !strings.Contains(withUser, "S-1-5-21-1-2-3-1001") {
		t.Fatalf("missing user sid: %s", withUser)
	}
	if strings.Contains(withUser, "WD") {
		t.Fatalf("everyone ACE: %s", withUser)
	}
}

func TestIsPipeGone(t *testing.T) {
	if !isPipeGone(io.EOF) {
		t.Fatal("eof")
	}
	if isPipeGone(ErrBlackFrame) || isPipeGone(ErrTimeout) || isPipeGone(ErrHelperTimeout) {
		t.Fatal("app errors must not look like disconnect")
	}
}
