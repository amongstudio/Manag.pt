//go:build windows

package notify

import (
	"strings"
	"testing"
)

func TestPipeSDDLDropsEveryone(t *testing.T) {
	sddl := PipeSDDL("")
	if strings.Contains(sddl, "WD") {
		t.Fatalf("everyone ACE still present: %s", sddl)
	}
	if !strings.Contains(sddl, "SY") || !strings.Contains(sddl, "BA") {
		t.Fatalf("expected SYSTEM+Admin: %s", sddl)
	}
	withUser := PipeSDDL("S-1-5-21-1-2-3-1001")
	if !strings.Contains(withUser, "S-1-5-21-1-2-3-1001") {
		t.Fatalf("missing user sid: %s", withUser)
	}
	if strings.Contains(withUser, "WD") {
		t.Fatalf("everyone ACE: %s", withUser)
	}
}
