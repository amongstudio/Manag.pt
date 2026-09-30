package installcfg

import "testing"

func TestParseInstallParams(t *testing.T) {
	got, err := Parse([]string{"/VERYSILENT", "/SERVER=https://pc.example.com", "/SECRET=s3cret"})
	if err != nil {
		t.Fatal(err)
	}
	if !got.VerySilent || got.Server != "https://pc.example.com" || got.Secret != "s3cret" {
		t.Fatalf("%+v", got)
	}
}

func TestParseRejectsNewlines(t *testing.T) {
	if _, err := Parse([]string{"/SECRET=line\nbreak"}); err == nil {
		t.Fatal("expected error")
	}
}

func TestDefaultYAMLMatchesInstaller(t *testing.T) {
	got := DefaultYAML("http://localhost:4000", `say "hi"`)
	want := "server_url: \"http://localhost:4000\"\nfallback_urls: []\nenrollment_secret: \"say \\\"hi\\\"\"\nheartbeat_interval_sec: 30\npoll_interval_sec: 15\nstatus_port: 17890\n"
	if got != want {
		t.Fatalf("yaml\n%s", got)
	}
}
