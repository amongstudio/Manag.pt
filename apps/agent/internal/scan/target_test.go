package scan

import "testing"

func TestTargetHostIPv6AndUserinfo(t *testing.T) {
	host, err := TargetHost("http://[::1]/health")
	if err != nil || host != "::1" {
		t.Fatalf("v6 %q %v", host, err)
	}
	host, err = TargetHost("http://127.0.0.1@8.8.8.8/admin")
	if err != nil || host != "8.8.8.8" {
		t.Fatalf("userinfo host %q %v", host, err)
	}
	if d := AuthorizeTarget(host, DefaultScope()); d.OK {
		t.Fatal("public host hidden in userinfo was allowed")
	}
	url, err := NucleiURL("http://[::1]/health", "::1")
	if err != nil || url != "http://[::1]/health" {
		t.Fatalf("url %q %v", url, err)
	}
}
