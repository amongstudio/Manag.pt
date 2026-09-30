//go:build windows

package inventory

import (
	"fmt"
	"testing"
)

func TestAppendWindowsUsersMapsDedupesAndCaps(t *testing.T) {
	rep := &Report{Users: []User{{Name: "Existing", SID: "S-1-5-21-1", Local: true}}}
	rows := []win32UserAccount{
		{Name: " Existing duplicate ", SID: "s-1-5-21-1", LocalAccount: true},
		{Name: " Alice ", SID: "S-1-5-21-2", LocalAccount: true, Disabled: true},
		{Name: "", SID: "S-1-5-21-3", LocalAccount: true},
		{Name: "No SID", LocalAccount: true},
		{Name: " no sid ", LocalAccount: true},
	}
	for i := 0; i < 250; i++ {
		rows = append(rows, win32UserAccount{
			Name:         fmt.Sprintf("user-%03d", i),
			SID:          fmt.Sprintf("S-1-5-21-%d", i+100),
			LocalAccount: true,
		})
	}

	appendWindowsUsers(rep, rows)

	if len(rep.Users) != 200 {
		t.Fatalf("users=%d want 200", len(rep.Users))
	}
	if got := rep.Users[1]; got.Name != "Alice" || got.SID != "S-1-5-21-2" || !got.Local || !got.Disabled {
		t.Fatalf("mapped user: %+v", got)
	}
	if got := rep.Users[2]; got.Name != "No SID" || !got.Local || got.Disabled {
		t.Fatalf("SID-less user: %+v", got)
	}
}
