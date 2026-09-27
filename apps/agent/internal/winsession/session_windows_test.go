//go:build windows

package winsession

import "testing"

func TestInteractiveLaunchDoesNotNeedWTSQueryUserToken(t *testing.T) {
	if InSession0() {
		t.Skip("Session 0 still uses WTSQueryUserToken / SeTcbPrivilege")
	}
	if !HasConsoleUser() {
		t.Skip("no interactive session")
	}
}
