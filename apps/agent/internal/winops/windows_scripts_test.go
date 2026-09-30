//go:build windows

package winops

import (
	"errors"
	"strings"
	"testing"
)

func TestDefenderPSScripts(t *testing.T) {
	set := defenderSetScript(DefenderWriteRequest{CloudProtection: "basic"})
	if set == "" || !strings.Contains(set, "MAPSReporting 1") || !strings.Contains(set, "ErrorActionPreference='Stop'") || !strings.Contains(set, "Import-Module Defender") {
		t.Fatalf("set script: %q", set)
	}
	if defenderSetScript(DefenderWriteRequest{}) != "" {
		t.Fatal("empty set must return empty script")
	}
	scan := defenderTryScript("Start-MpScan -ScanType QuickScan")
	if !strings.Contains(scan, "Start-MpScan") || !strings.Contains(scan, "Import-Module Defender") {
		t.Fatalf("scan script: %q", scan)
	}
	offline := defenderTryScript("Start-MpWDOScan")
	if !strings.Contains(offline, "Start-MpWDOScan") {
		t.Fatalf("offline script: %q", offline)
	}
	allow := defenderThreatScript(DefenderActionRequest{ThreatID: "311942", Action: "allow"})
	if !strings.Contains(allow, "ThreatIDDefaultAction_Ids") || !strings.Contains(allow, "311942") {
		t.Fatalf("allow script: %q", allow)
	}
	remove := defenderThreatScript(DefenderActionRequest{ThreatID: "9", Action: "remove"})
	if !strings.Contains(remove, "Remove-MpThreat") {
		t.Fatalf("remove script: %q", remove)
	}
	restore := defenderThreatScript(DefenderActionRequest{ThreatID: "9", Action: "restore"})
	if !strings.Contains(restore, "Restore-MpThreat") {
		t.Fatalf("restore script: %q", restore)
	}
	if err := mapDefenderPSErr("ERR:Tamper Protection is on\n", nil); err == nil || !strings.Contains(err.Error(), "tamper") {
		t.Fatalf("tamper err: %v", err)
	}
	if err := mapDefenderPSErr("ERR:Access is denied\n", nil); err == nil || !errors.Is(err, ErrDefenderAccess) {
		t.Fatalf("access err: %v", err)
	}
	if err := mapDefenderPSErr("ERR:Threat not found\n", nil); err == nil || !strings.Contains(err.Error(), "defender_failed") {
		t.Fatalf("generic err: %v", err)
	}
	if !defenderOutputOK("ok\n") || defenderOutputOK("") {
		t.Fatal("defenderOutputOK")
	}
	if err := mapDefenderPSErr("", ErrNoSession); err == nil || !strings.Contains(err.Error(), "defender_no_interactive_session") {
		t.Fatalf("no session err: %v", err)
	}
	if formatCommandLine(`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "-Command", "Write-Output ok") == "" {
		t.Fatal("formatCommandLine")
	}
}

func TestParseBitLockerJSONProtectionOff(t *testing.T) {
	vols := parseBitLockerJSON(`{"MountPoint":"E:","ProtectionStatus":"Off","LockStatus":"Locked","KeyProtector":[{"KeyProtectorType":"Password","KeyProtectorId":"{abc}"}]}`)
	if len(vols) != 1 || vols[0].MountPoint != "E:" || vols[0].ProtectionStatus != "off" || vols[0].LockStatus != "locked" {
		t.Fatalf("%+v", vols)
	}
	if len(vols[0].KeyProtectors) != 1 || vols[0].KeyProtectors[0].Type != "password" {
		t.Fatalf("kp %+v", vols[0].KeyProtectors)
	}
	if vols[0].EncryptionPercent != nil {
		t.Fatalf("missing percent should stay nil: %+v", vols[0].EncryptionPercent)
	}
}
