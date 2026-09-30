package software

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestParseInstallRejectsInjection(t *testing.T) {
	for _, id := range []string{"-o evil", "Git.Git;calc", "a b", "Git.Git&&x", "", "--source=evil"} {
		if _, err := ParseInstall(json.RawMessage(`{"id":` + quote(id) + `}`)); err == nil {
			t.Fatalf("accepted %q", id)
		}
	}
	req, err := ParseInstall(json.RawMessage(`{"id":"Git.Git","version":"2.45.1","scope":"machine"}`))
	if err != nil {
		t.Fatal(err)
	}
	args := WingetInstallArgs(req)
	if !slices.Contains(args, "--exact") || !slices.Contains(args, "--disable-interactivity") || args[2] != "Git.Git" {
		t.Fatalf("args=%v", args)
	}
	if _, err := ParseInstall(json.RawMessage(`{"id":"Git.Git","version":"1 --force"}`)); err == nil {
		t.Fatal("version injection accepted")
	}
}

func TestParseUninstall(t *testing.T) {
	if _, err := ParseUninstall(json.RawMessage(`{"name":"-x"}`)); err == nil {
		t.Fatal("flag name accepted")
	}
	if _, err := ParseUninstall(json.RawMessage(`{"name":"7-Zip","productCode":"23170F69"}`)); err == nil {
		t.Fatal("bad product code accepted")
	}
	req, err := ParseUninstall(json.RawMessage(`{"name":"7-Zip 23.01 (x64)"}`))
	if err != nil {
		t.Fatal(err)
	}
	args := WingetUninstallArgs(req)
	if args[1] != "--name" || args[2] != "7-Zip 23.01 (x64)" || !slices.Contains(args, "--silent") {
		t.Fatalf("args=%v", args)
	}
}

func TestMsiProductCodeFromUninstallString(t *testing.T) {
	code, ok := MsiProductCodeFromUninstallString(`MsiExec.exe /I{23170F69-40C1-2702-2301-000001000000}`)
	if !ok || code != "{23170F69-40C1-2702-2301-000001000000}" {
		t.Fatalf("code=%s ok=%v", code, ok)
	}
	if _, ok := MsiProductCodeFromUninstallString(`MsiExec.exe /I{23170F69-40C1-2702-2301-000001000000} & calc`); ok {
		t.Fatal("trailing command accepted")
	}
	if _, ok := MsiProductCodeFromUninstallString(`"C:\Program Files\App\uninst.exe" /S`); ok {
		t.Fatal("non-msi accepted")
	}
}

func TestValidateQuietUninstall(t *testing.T) {
	ok := []string{`C:\Program Files\7-Zip\Uninstall.exe`, "/S"}
	if err := ValidateQuietUninstall(ok); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]string{
		{`C:\Windows\System32\cmd.exe`, "/c", "del"},
		{`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "-c", "x"},
		{`C:\Windows\System32\rundll32.exe`, "x.dll,Entry"},
		{`uninst.exe`, "/S"},
		{`C:\app\uninstall.bat`},
		{},
	} {
		if err := ValidateQuietUninstall(bad); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
