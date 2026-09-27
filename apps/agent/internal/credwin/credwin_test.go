package credwin

import (
	"runtime"
	"strings"
	"testing"
)

func TestParseCredentialPayloads(t *testing.T) {
	list, err := ParseList([]byte(`{"sources":["windows","browser"],"reveal":true}`))
	if err != nil || !list.Reveal || len(list.Sources) != 2 {
		t.Fatalf("%+v %v", list, err)
	}
	if _, err := ParseList([]byte(`{"sources":["vault"]}`)); err != ErrInvalidPayload {
		t.Fatalf("bad source: %v", err)
	}
	w, err := ParseWrite([]byte(`{"target":"Git:https://github.com","username":"a","secret":"s"}`))
	if err != nil || w.Target == "" {
		t.Fatalf("%+v %v", w, err)
	}
	if _, err := ParseWrite([]byte(`{"target":"x"}`)); err != ErrInvalidPayload {
		t.Fatalf("secret: %v", err)
	}
	g, err := ParseGenerate([]byte(`{"length":16,"save":true,"target":"app:demo"}`))
	if err != nil || g.Length != 16 || !g.Save {
		t.Fatalf("%+v %v", g, err)
	}
	pw, err := RandomPassword(12)
	if err != nil || len(pw) != 12 {
		t.Fatalf("pw %q %v", pw, err)
	}
	rest, err := ParseRestore([]byte(`{"credentials":[{"target":"app:demo","secret":"s1","source":"generated"}]}`))
	if err != nil || len(rest.Credentials) != 1 || rest.Credentials[0].Target != "app:demo" {
		t.Fatalf("%+v %v", rest, err)
	}
	if _, err := ParseRestore([]byte(`{"credentials":[]}`)); err != ErrInvalidPayload {
		t.Fatalf("empty restore: %v", err)
	}
}

func TestParseFirefoxLogins(t *testing.T) {
	raw := []byte(`{"logins":[{"hostname":"https://example.com","guid":"{abc}","timesUsed":3,"timeLastUsed":1700000000000}]}`)
	rows := ParseFirefoxLogins(raw, "abcd.default-release")
	if len(rows) != 1 || rows[0].Target != "https://example.com" || !rows[0].Locked || rows[0].Browser != "firefox" {
		t.Fatalf("%+v", rows)
	}
	if rows[0].Secret != "" {
		t.Fatal("firefox must not include NSS secrets")
	}
	if rows[0].Comment == "" || !strings.Contains(rows[0].Comment, "metadata only") {
		t.Fatalf("firefox comment: %q", rows[0].Comment)
	}
}

func TestGenerateCharsetAndChromeTime(t *testing.T) {
	g, err := ParseGenerate([]byte(`{"length":12,"upper":false,"lower":false,"digits":true,"symbols":false}`))
	if err != nil || !g.Digits || g.Upper {
		t.Fatalf("%+v %v", g, err)
	}
	if _, err := ParseGenerate([]byte(`{"length":12,"upper":false,"lower":false,"digits":false,"symbols":false}`)); err != ErrInvalidPayload {
		t.Fatalf("empty charset: %v", err)
	}
	pw, err := RandomPasswordCharset(16, "23456789")
	if err != nil || len(pw) != 16 {
		t.Fatalf("pw %q %v", pw, err)
	}
	for _, r := range pw {
		if r < '2' || r > '9' {
			t.Fatalf("charset leak %q", pw)
		}
	}
	ts := chromeTime("13350000000000000")
	if ts == "" {
		t.Fatal("chrome time")
	}
}

func TestGenerateKeepsPasswordWhenWriteFails(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows may persist CredWrite")
	}
	out, err := Generate(GenerateRequest{Length: 12, Save: true, Target: "app:demo"})
	if out == nil || len(out.Password) != 12 {
		t.Fatalf("password should still be returned: %+v %v", out, err)
	}
	if err != ErrUnsupported {
		t.Fatalf("err %v", err)
	}
}

func TestUnsupportedCredentials(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows implements CredEnumerate")
	}
	if _, err := List(ListRequest{}); err != ErrUnsupported {
		t.Fatalf("list: %v", err)
	}
	if _, err := Restore(RestoreRequest{}); err != ErrUnsupported {
		t.Fatalf("restore: %v", err)
	}
}
