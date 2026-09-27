package winops

import (
	"encoding/json"
	"errors"
	"runtime"
	"strings"
	"testing"
)

func TestParseEventLog(t *testing.T) {
	req, err := ParseEventLog([]byte(`{}`))
	if err != nil || req.Log != "System" || req.Newest != 50 || req.Level != "all" {
		t.Fatalf("default %+v %v", req, err)
	}
	req, err = ParseEventLog([]byte(`{"log":"Application","newest":20,"level":"error"}`))
	if err != nil || req.Log != "Application" || req.Newest != 20 || req.Level != "error" {
		t.Fatalf("app %+v %v", req, err)
	}
	req, err = ParseEventLog([]byte(`{"log":"Microsoft-Windows-WindowsUpdateClient/Operational"}`))
	if err != nil || req.Log != "Microsoft-Windows-WindowsUpdateClient/Operational" {
		t.Fatalf("channel %+v %v", req, err)
	}
	if _, err := ParseEventLog([]byte(`{"log":"C:\\Windows\\System32\\winevt\\Logs\\System.evtx"}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("path: %v", err)
	}
	if _, err := ParseEventLog([]byte(`{"log":"compmgmt.msc"}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("msc: %v", err)
	}
	if _, err := ParseEventLog([]byte(`{"newest":0}`)); err != nil {
		t.Fatalf("newest 0 uses default: %v", err)
	}
	if _, err := ParseEventLog([]byte(`{"newest":201}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("newest cap: %v", err)
	}
	if _, err := ParseEventLog([]byte(`{"level":"panic"}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("level: %v", err)
	}
	if xpathForLevel("error") != "*[System[(Level=1 or Level=2)]]" {
		t.Fatal(xpathForLevel("error"))
	}
}

func TestParseUpdateAndAssist(t *testing.T) {
	req, err := ParseUpdate([]byte(`{"online":true}`))
	if err != nil || !req.Online {
		t.Fatalf("update %+v %v", req, err)
	}
	if _, err := ParseUpdate([]byte(`{`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("bad json: %v", err)
	}
	assist, err := ParseAssist([]byte(`{}`))
	if err != nil || assist.App != "quickassist" {
		t.Fatalf("default assist %+v %v", assist, err)
	}
	assist, err = ParseAssist([]byte(`{"app":"msra"}`))
	if err != nil || assist.App != "msra" {
		t.Fatalf("msra %+v %v", assist, err)
	}
	if _, err := ParseAssist([]byte(`{"app":"compmgmt.msc"}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("mmc: %v", err)
	}
}

func TestParseTasksAndCapabilities(t *testing.T) {
	req, err := ParseTasks([]byte(`{"query":"Defrag"}`))
	if err != nil || req.Query != "Defrag" {
		t.Fatalf("tasks %+v %v", req, err)
	}
	if _, err := ParseTasks([]byte(`{"query":"bad\nquery"}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("query: %v", err)
	}
	en, err := ParseTaskEnabled([]byte(`{"path":"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","enabled":false}`))
	if err != nil || !strings.HasPrefix(en.Path, `\`) || en.Enabled {
		t.Fatalf("enabled %+v %v", en, err)
	}
	if _, err := ParseTaskEnabled([]byte(`{"path":"..\\evil","enabled":true}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("dotdot: %v", err)
	}
	if _, err := ParseTaskEnabled([]byte(`{"path":"taskmgr.msc","enabled":true}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("msc: %v", err)
	}
	if _, err := ParseTaskEnabled([]byte(`{"path":"\\Foo"}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("missing enabled: %v", err)
	}
	caps, err := ParseCapabilities([]byte(`{"query":"Rsat"}`))
	if err != nil || caps.Query != "Rsat" {
		t.Fatalf("caps %+v %v", caps, err)
	}
	if capabilityKind("Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0") != "rsat" {
		t.Fatal("rsat kind")
	}
	if capabilityKind("Media.MediaFeaturePack~~~~0.0.1.0") != "media" {
		t.Fatal("media kind")
	}
}

func TestParseDefenderActionAndPS(t *testing.T) {
	req, err := ParseDefenderWrite([]byte(`{"realtime":true,"pua":false}`))
	if err != nil || req.Realtime == nil || !*req.Realtime {
		t.Fatalf("write %+v %v", req, err)
	}
	if _, err := ParseDefenderWrite([]byte(`{}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("empty write: %v", err)
	}
	scan, err := ParseDefenderScan([]byte(`{"type":"full"}`))
	if err != nil || scan.Type != "full" {
		t.Fatalf("scan %+v %v", scan, err)
	}
	if _, err := ParseDefenderAction([]byte(`{"threatId":"1","action":"quarantine"}`)); err != nil {
		t.Fatalf("quarantine: %v", err)
	}
	if _, err := ParseDefenderAction([]byte(`{"threatId":"1","action":"drop"}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("bad action: %v", err)
	}
	ps := parseDefenderPS("STATUS:{\"AntivirusEnabled\":true,\"RealTimeProtectionEnabled\":true,\"AntivirusSignatureVersion\":\"1.2.3\"}\nPREF:{\"DisableRealtimeMonitoring\":false,\"MAPSReporting\":2,\"PUAProtection\":1}\nTHREAT:[{\"ThreatID\":9,\"ThreatName\":\"Test:Malware\",\"SeverityID\":5,\"ThreatStatusID\":3}]")
	if ps == nil || !ps.AntivirusEnabled || ps.Preferences == nil || ps.Preferences.CloudProtection != "advanced" || len(ps.Threats) != 1 || ps.Threats[0].Status != "quarantined" {
		t.Fatalf("ps %+v", ps)
	}
	if asrRuleName("d4f940ab-401b-4efc-aadc-ad5f3c50688a") == "" {
		t.Fatal("asr name")
	}
	if parseDefenderPS("{}") != nil || parseDefenderPS(`{"error":"x"}`) != nil {
		t.Fatal("empty defender json must not look like all-off")
	}
	if parseDefenderPSTagged("STATUS:{}") != nil {
		t.Fatal("empty tagged status")
	}
}

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

func TestParseBitLockerWrite(t *testing.T) {
	req, err := ParseBitLockerWrite([]byte(`{"action":"suspend","mountPoint":"c:"}`))
	if err != nil || req.Action != "suspend" || req.MountPoint != "C:" {
		t.Fatalf("%+v %v", req, err)
	}
	if _, err := ParseBitLockerWrite([]byte(`{"action":"unlock","mountPoint":"D:"}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("unlock secret: %v", err)
	}
	if _, err := ParseBitLockerWrite([]byte(`{"action":"unlock","mountPoint":"D:","password":"pw"}`)); err != nil {
		t.Fatalf("unlock pw: %v", err)
	}
	if _, err := ParseBitLockerWrite([]byte(`{"action":"add_protector","mountPoint":"C:"}`)); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("protector type: %v", err)
	}
	if _, err := ParseBitLockerWrite([]byte(`{"action":"remove_protector","mountPoint":"C:","protectorId":"{id}"}`)); err != nil {
		t.Fatalf("remove: %v", err)
	}
}

func TestUnsupportedPlatform(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows implements EvtQuery and WUAPI")
	}
	if _, err := EventLog(EventLogRequest{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("EventLog: %v", err)
	}
	if _, err := WindowsUpdate(UpdateRequest{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("WindowsUpdate: %v", err)
	}
	if _, err := StartQuickAssist(AssistRequest{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("StartQuickAssist: %v", err)
	}
	if _, err := AdminCenter(); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("AdminCenter: %v", err)
	}
	if _, err := Tasks(TasksRequest{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Tasks: %v", err)
	}
	if _, err := SetTaskEnabled(TaskWriteRequest{Path: `\Foo`, Enabled: true}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("SetTaskEnabled: %v", err)
	}
	if _, err := Defender(); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Defender: %v", err)
	}
	if _, err := BitLocker(); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("BitLocker: %v", err)
	}
	if _, err := Capabilities(CapabilitiesRequest{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Capabilities: %v", err)
	}
}

func TestClipMessage(t *testing.T) {
	if clipMessage("  hi  ") != "hi" {
		t.Fatal(clipMessage("  hi  "))
	}
	long := stringsRepeat("x", 500)
	got := clipMessage(long)
	if len([]rune(got)) != maxMessage {
		t.Fatalf("len %d", len([]rune(got)))
	}
}

func TestWindowsReadsDoNotPanic(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip()
	}
	events, err := EventLog(EventLogRequest{Log: "System", Newest: 5, Level: "all"})
	if err != nil {
		if errors.Is(err, ErrAccessDenied) {
			t.Skip("event_log_access_denied")
		}
		t.Fatalf("EventLog: %v", err)
	}
	raw, err := json.Marshal(events)
	if err != nil || len(raw) < 2 {
		t.Fatalf("marshal %s %v", raw, err)
	}
	wac, err := AdminCenter()
	if err != nil && !errors.Is(err, ErrWACAccessDenied) {
		t.Fatalf("AdminCenter: %v", err)
	}
	if wac == nil && err == nil {
		t.Fatal("expected WAC result")
	}
}

func TestWindowsN2Smoke(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip()
	}
	tasks, err := Tasks(TasksRequest{})
	if err != nil {
		if errors.Is(err, ErrTaskAccessDenied) {
			t.Skip("task_access_denied")
		}
		t.Fatalf("Tasks: %v", err)
	}
	raw, err := json.Marshal(tasks)
	if err != nil || len(raw) < 2 {
		t.Fatalf("tasks marshal %s %v", raw, err)
	}
	def, err := Defender()
	if err != nil && !errors.Is(err, ErrDefenderAccess) && !errors.Is(err, ErrDefenderUnavailable) {
		t.Fatalf("Defender: %v", err)
	}
	if def != nil {
		if _, err := json.Marshal(def); err != nil {
			t.Fatalf("defender marshal: %v", err)
		}
	}
	bl, err := BitLocker()
	if err != nil && !errors.Is(err, ErrBitLockerAccess) && !errors.Is(err, ErrBitLockerUnavailable) {
		t.Fatalf("BitLocker: %v", err)
	}
	if bl != nil {
		if _, err := json.Marshal(bl); err != nil {
			t.Fatalf("bitlocker marshal: %v", err)
		}
	}
	caps, err := Capabilities(CapabilitiesRequest{Query: "Rsat"})
	if err != nil && !errors.Is(err, ErrDismAccessDenied) && !errors.Is(err, ErrDismUnavailable) {
		t.Fatalf("Capabilities: %v", err)
	}
	if caps != nil {
		if _, err := json.Marshal(caps); err != nil {
			t.Fatalf("caps marshal: %v", err)
		}
	}
}

func stringsRepeat(s string, n int) string {
	b := make([]byte, 0, len(s)*n)
	for i := 0; i < n; i++ {
		b = append(b, s...)
	}
	return string(b)
}
