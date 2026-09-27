package smbwin

import "testing"

func TestNormalizeUNCAndPath(t *testing.T) {
	unc, err := NormalizeUNC(`\\fileserver\share\dir`)
	if err != nil || unc != `\\fileserver\share\dir` {
		t.Fatalf("%q %v", unc, err)
	}
	trimmed, err := NormalizeUNC(`\\fileserver\share\`)
	if err != nil || trimmed != `\\fileserver\share` {
		t.Fatalf("trim %q %v", trimmed, err)
	}
	if _, err := NormalizeUNC(`C:\Windows`); err != ErrInvalidPayload {
		t.Fatalf("drive: %v", err)
	}
	if _, err := NormalizeUNC(`\\evil\..\share`); err != ErrInvalidPayload {
		t.Fatalf("dotdot: %v", err)
	}
	if _, err := NormalizeUNC(`\\server`); err != ErrInvalidPayload {
		t.Fatalf("share required: %v", err)
	}
	p, err := NormalizeSharePath(`Z:\folder`)
	if err != nil || p != `Z:\folder` {
		t.Fatalf("drive path %q %v", p, err)
	}
	root, err := NormalizeSharePath(`z:`)
	if err != nil || root != `Z:\` {
		t.Fatalf("drive root %q %v", root, err)
	}
	slash, err := NormalizeSharePath(`z:/docs/a`)
	if err != nil || slash != `Z:\docs\a` {
		t.Fatalf("slash %q %v", slash, err)
	}
	req, err := ParseConnect([]byte(`{"unc":"\\\\srv\\data","username":"u","password":"p","drive":"s"}`))
	if err != nil || req.UNC == "" || req.Drive != "S" {
		t.Fatalf("connect %+v %v", req, err)
	}
}

func TestParseListAndDisconnect(t *testing.T) {
	req, err := ParseList([]byte(`{"path":"\\\\files\\share\\dir"}`))
	if err != nil || req.Path != `\\files\share\dir` {
		t.Fatalf("list %+v %v", req, err)
	}
	if _, err := ParseList([]byte(`{"path":"C:\\Windows"}`)); err != nil {
		t.Fatalf("local drive list should parse, gate later: %v", err)
	}
	if _, err := ParseList([]byte(`{}`)); err != ErrInvalidPayload {
		t.Fatalf("empty list: %v", err)
	}
	drive, err := ParseDisconnect([]byte(`{"drive":"z"}`))
	if err != nil || drive != "Z:" {
		t.Fatalf("disconnect drive %q %v", drive, err)
	}
	unc, err := ParseDisconnect([]byte(`{"unc":"\\\\srv\\data"}`))
	if err != nil || unc != `\\srv\data` {
		t.Fatalf("disconnect unc %q %v", unc, err)
	}
	if _, err := ParseDisconnect([]byte(`{}`)); err != ErrInvalidPayload {
		t.Fatalf("empty disconnect: %v", err)
	}
}

func TestPathAllowedAndJoin(t *testing.T) {
	if JoinSharePath(`\\srv\data`, `folder`) != `\\srv\data\folder` {
		t.Fatal("join unc")
	}
	if JoinSharePath(`Z:\`, `a.txt`) != `Z:\a.txt` {
		t.Fatal("join drive")
	}
	if !PathAllowed(`\\srv\data\dir`, nil) {
		t.Fatal("unc allowed without known shares")
	}
	if PathAllowed(`C:\Windows`, nil) {
		t.Fatal("local drive must not be allowed without a mapping")
	}
	known := []Share{{Name: "Z:", Path: `Z:\`, Drive: "Z:", Kind: "mapped", Connected: true}}
	if !PathAllowed(`Z:\docs\a.txt`, known) {
		t.Fatal("mapped child")
	}
	if PathAllowed(`C:\docs`, known) {
		t.Fatal("other drive")
	}
	got, err := ResolveFilePath(`\\files\share\a.txt`, nil)
	if err != nil || got != `\\files\share\a.txt` {
		t.Fatalf("resolve unc %q %v", got, err)
	}
	if _, err := ResolveFilePath(`C:\Windows`, known); err != ErrNotConnected {
		t.Fatalf("local resolve: %v", err)
	}
}

func TestIsRemoteAndDrive(t *testing.T) {
	if !IsRemotePath(`\\srv\share`) || !IsRemotePath(`//srv/share`) {
		t.Fatal("remote")
	}
	if IsRemotePath(`Z:\share`) || IsDrivePath(`\\srv\share`) {
		t.Fatal("kind mix")
	}
	if !IsDrivePath(`z:\foo`) || !IsDrivePath(`C:`) {
		t.Fatal("drive")
	}
}

func TestDosDeviceToUNC(t *testing.T) {
	cases := map[string]string{
		`\??\UNC\files\data`: `\\files\data`,
		`\Device\Mup\files\data`: `\\files\data`,
		`\Device\LanmanRedirector\;Z:0000000000001234\srv\share`: `\\srv\share`,
		`\Device\Mup\;LanmanRedirector\;Z:0\office\docs`: `\\office\docs`,
	}
	for in, want := range cases {
		got := DosDeviceToUNC(in)
		if got != want {
			t.Fatalf("%q -> %q want %q", in, got, want)
		}
	}
	if DosDeviceToUNC("") != "" {
		t.Fatal("empty")
	}
}
