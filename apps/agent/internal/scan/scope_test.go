package scan

import "testing"

func TestAuthorizeRejectsPublicAndExcludedAndLabLAN(t *testing.T) {
	scope := DefaultScope()
	if d := AuthorizeTarget("8.8.8.8", scope); d.OK || d.Error != "target_refused" {
		t.Fatalf("public %+v", d)
	}
	if d := AuthorizeTarget("192.168.1.10", scope); d.OK || d.Error != "target_refused" {
		t.Fatalf("lab lan %+v", d)
	}
	scope.ExcludedHosts = []string{"127.0.0.1"}
	if d := AuthorizeTarget("127.0.0.1", scope); d.OK || d.Error != "target_excluded" {
		t.Fatalf("excluded %+v", d)
	}
	scope.ExcludedHosts = nil
	if d := AuthorizeTarget("127.0.0.1", scope); !d.OK {
		t.Fatalf("loopback %+v", d)
	}
}

func TestAuthorizeOwnedLANWhenLabOff(t *testing.T) {
	off := false
	scope := Scope{LabMode: &off, AuthorizedNetworks: []string{"192.168.1.0/24"}, ExcludedHosts: []string{"192.168.1.10"}}
	if d := AuthorizeTarget("192.168.1.20", scope); !d.OK {
		t.Fatalf("owned %+v", d)
	}
	if d := AuthorizeTarget("192.168.1.10", scope); d.Error != "target_excluded" {
		t.Fatalf("excluded in lan %+v", d)
	}
	if d := AuthorizeTarget("10.1.1.1", scope); d.OK {
		t.Fatalf("outside %+v", d)
	}
}
