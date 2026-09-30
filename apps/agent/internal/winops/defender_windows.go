//go:build windows

package winops

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

func Defender() (*DefenderStatus, error) {
	out, err := defenderWMI()
	if err == nil && out != nil {
		out.Source = "wmi"
		out.Available = true
		out.ThreatCount, out.ActiveThreatCount = summarizeThreats(out.Threats)
		fillScanProgress(out)
		return out, nil
	}
	if ps := defenderPowerShell(); ps != nil {
		ps.Available = true
		fillScanProgress(ps)
		return ps, nil
	}
	if err != nil {
		return nil, mapDefenderErr(err)
	}
	return nil, ErrDefenderUnavailable
}

func defenderWMI() (*DefenderStatus, error) {
	var out *DefenderStatus
	err := withWMI(`root\Microsoft\Windows\Defender`, func(svc *ole.IDispatch) error {
		found := false
		qerr := wmiQuery(svc, "SELECT * FROM MSFT_MpComputerStatus", func(item *ole.IDispatch) error {
			row := DefenderStatus{
				AntivirusEnabled:            propBool(item, "AntivirusEnabled"),
				AntispywareEnabled:          propBool(item, "AntispywareEnabled"),
				RealtimeProtectionEnabled:   propBool(item, "RealTimeProtectionEnabled"),
				IoavProtectionEnabled:       propBool(item, "IoavProtectionEnabled"),
				NISEnabled:                  propBool(item, "NISEnabled"),
				AMServiceEnabled:            propBool(item, "AMServiceEnabled"),
				OnAccessProtectionEnabled:   propBool(item, "OnAccessProtectionEnabled"),
				BehaviorMonitorEnabled:      propBool(item, "BehaviorMonitorEnabled"),
				AntivirusSignatureVersion:   propString(item, "AntivirusSignatureVersion"),
				AntivirusSignatureAge:       intPtrIfPresent(item, "AntivirusSignatureAge"),
				AntivirusSignatureUpdated:   firstTime(item, "AntivirusSignatureLastUpdated"),
				AntispywareSignatureVersion: propString(item, "AntispywareSignatureVersion"),
				NISSignatureVersion:         propString(item, "NISSignatureVersion"),
				AMEngineVersion:             firstString(item, "AMEngineVersion", "AntivirusSignatureVersion"),
				ProductVersion:              propString(item, "AMProductVersion"),
				ServiceVersion:              propString(item, "AMServiceVersion"),
				QuickScanAge:                intPtrIfPresent(item, "QuickScanAge"),
				FullScanAge:                 intPtrIfPresent(item, "FullScanAge"),
				ComputerState:               defenderComputerState(propInt(item, "ComputerState")),
				LastQuickScan:               firstTime(item, "QuickScanEndTime", "LastQuickScanTimeStamp"),
				LastFullScan:                firstTime(item, "FullScanEndTime", "LastFullScanTimeStamp"),
				LastQuickScanStart:          firstTime(item, "QuickScanStartTime"),
				LastFullScanStart:           firstTime(item, "FullScanStartTime"),
				TamperProtected:             propBool(item, "IsTamperProtected") || propBool(item, "TamperProtected"),
				IsVirtualMachine:            propBool(item, "IsVirtualMachine"),
				DefenderSignaturesOutOfDate: propBool(item, "DefenderSignaturesOutOfDate"),
				FullScanOverdue:             propBool(item, "FullScanOverdue"),
				QuickScanOverdue:            propBool(item, "QuickScanOverdue"),
				RebootRequired:              propBool(item, "RebootRequired"),
			}
			out = &row
			found = true
			return nil
		})
		if qerr != nil {
			return qerr
		}
		if !found {
			return ErrDefenderUnavailable
		}
		out.Preferences = defenderPreferences(svc)
		out.Threats, out.ThreatsTruncated = defenderThreats(svc)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func defenderPowerShell() *DefenderStatus {
	script := `$ErrorActionPreference='Continue'
$st = Get-MpComputerStatus | ConvertTo-Json -Compress -Depth 4
$pr = Get-MpPreference | ConvertTo-Json -Compress -Depth 5
$th = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | Select-Object -First 80) | ConvertTo-Json -Compress -Depth 5
Write-Output ('STATUS:' + $st)
Write-Output ('PREF:' + $pr)
Write-Output ('THREAT:' + $th)`
	raw, err := runHiddenInSession(90*time.Second, system32("WindowsPowerShell\\v1.0\\powershell.exe"),
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	if raw == "" {
		_ = err
		return nil
	}
	return parseDefenderPS(raw)
}

func firstString(item *ole.IDispatch, names ...string) string {
	for _, name := range names {
		if s := propString(item, name); s != "" {
			return s
		}
	}
	return ""
}

func firstTime(item *ole.IDispatch, names ...string) string {
	for _, name := range names {
		if s := propTime(item, name); s != "" {
			return s
		}
		if s := parseCIMDate(propString(item, name)); s != "" {
			return s
		}
	}
	return ""
}

func defenderPreferences(svc *ole.IDispatch) *DefenderPreferences {
	var pref *DefenderPreferences
	_ = wmiQuery(svc, "SELECT * FROM MSFT_MpPreference", func(item *ole.IDispatch) error {
		pref = &DefenderPreferences{
			RealtimeMonitoring:     !propBool(item, "DisableRealtimeMonitoring"),
			BehaviorMonitoring:     !propBool(item, "DisableBehaviorMonitoring"),
			IOAVProtection:         !propBool(item, "DisableIOAVProtection"),
			ScriptScanning:         !propBool(item, "DisableScriptScanning"),
			CloudProtection:        mapsName(propInt(item, "MAPSReporting")),
			CloudBlockLevel:        cloudBlockName(propInt(item, "CloudBlockLevel")),
			SubmitSamples:          submitSamplesName(propInt(item, "SubmitSamplesConsent")),
			PUAProtection:          onOffAudit(propInt(item, "PUAProtection")),
			NetworkProtection:      onOffAudit(propInt(item, "EnableNetworkProtection")),
			ControlledFolderAccess: onOffAudit(propInt(item, "EnableControlledFolderAccess")),
			ASRRules:               zipASR(stringSliceProp(item, "AttackSurfaceReductionRules_Ids"), intSliceProp(item, "AttackSurfaceReductionRules_Actions")),
			ExclusionPaths:         stringSliceProp(item, "ExclusionPath"),
			ExclusionExtensions:    stringSliceProp(item, "ExclusionExtension"),
			ExclusionProcesses:     stringSliceProp(item, "ExclusionProcess"),
		}
		return nil
	})
	return pref
}

func defenderThreats(svc *ole.IDispatch) ([]DefenderThreat, bool) {
	out := []DefenderThreat{}
	truncated := false
	_ = wmiQuery(svc, "SELECT * FROM MSFT_MpThreatDetection", func(item *ole.IDispatch) error {
		if len(out) >= maxThreats {
			truncated = true
			return nil
		}
		id := firstString(item, "ThreatID", "ThreatId")
		if id == "" {
			id = fmt.Sprintf("%d", propInt(item, "ThreatID"))
			if id == "0" {
				id = propString(item, "InstanceID")
			}
		}
		name := firstString(item, "ThreatName")
		if name == "" {
			name = id
		}
		if name == "" || name == "0" {
			return nil
		}
		status := threatStatusName(propInt(item, "ThreatStatusID"))
		out = append(out, DefenderThreat{
			ID:            id,
			InstanceID:    firstString(item, "InstanceID", "InstanceId"),
			Name:          name,
			Severity:      threatSeverity(propInt(item, "SeverityID")),
			Status:        status,
			Resources:     stringSliceProp(item, "Resources"),
			DetectionTime: firstTime(item, "InitialDetectionTime", "LastThreatStatusChangeTime"),
			Action:        threatActionName(propInt(item, "ActionID")),
			Process:       propString(item, "ProcessName"),
			User:          propString(item, "DomainUser"),
		})
		return nil
	})
	if len(out) == 0 {
		_ = wmiQuery(svc, "SELECT * FROM MSFT_MpThreat", func(item *ole.IDispatch) error {
			if len(out) >= maxThreats {
				truncated = true
				return nil
			}
			id := firstString(item, "ThreatID", "ThreatId")
			name := firstString(item, "ThreatName", "CategoryID")
			if id == "" && name == "" {
				return nil
			}
			if name == "" {
				name = id
			}
			out = append(out, DefenderThreat{
				ID:       id,
				Name:     name,
				Severity: threatSeverity(propInt(item, "SeverityID")),
				Status:   threatStatusName(propInt(item, "ThreatStatusID")),
			})
			return nil
		})
	}
	return out, truncated
}

func intSliceProp(item *ole.IDispatch, name string) []int {
	if item == nil {
		return nil
	}
	v, err := oleutil.GetProperty(item, name)
	if err != nil {
		return nil
	}
	defer v.Clear()
	val := v.Value()
	switch t := val.(type) {
	case []int:
		return t
	case []int32:
		out := make([]int, 0, len(t))
		for _, n := range t {
			out = append(out, int(n))
		}
		return out
	case []int64:
		out := make([]int, 0, len(t))
		for _, n := range t {
			out = append(out, int(n))
		}
		return out
	default:
		if arr := v.ToArray(); arr != nil {
			raw := arr.ToValueArray()
			out := make([]int, 0, len(raw))
			for _, item := range raw {
				s := strings.TrimSpace(fmt.Sprint(item))
				if n, err := strconv.Atoi(s); err == nil {
					out = append(out, n)
				}
			}
			return out
		}
	}
	return nil
}

func stringSliceProp(item *ole.IDispatch, name string) []string {
	if item == nil {
		return nil
	}
	v, err := oleutil.GetProperty(item, name)
	if err != nil {
		return nil
	}
	defer v.Clear()
	val := v.Value()
	switch t := val.(type) {
	case []string:
		return clipStrings(t, 40)
	case string:
		if t == "" {
			return nil
		}
		return []string{t}
	default:
		if arr := v.ToArray(); arr != nil {
			raw := arr.ToValueArray()
			out := make([]string, 0, len(raw))
			for _, item := range raw {
				s := strings.TrimSpace(fmt.Sprint(item))
				if s != "" && s != "<nil>" {
					out = append(out, s)
				}
				if len(out) >= 40 {
					break
				}
			}
			return out
		}
	}
	return nil
}

func clipStrings(in []string, max int) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		out = append(out, s)
		if len(out) >= max {
			break
		}
	}
	return out
}

func mapDefenderErr(err error) error {
	if err == nil {
		return nil
	}
	if isAccessDenied(err) {
		return ErrDefenderAccess
	}
	if isWMIMissing(err) {
		return ErrDefenderUnavailable
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "invalid class") || strings.Contains(msg, "not found") || strings.Contains(msg, "invalid namespace") {
		return ErrDefenderUnavailable
	}
	return err
}

func SetDefender(req DefenderWriteRequest) (*DefenderWriteResult, error) {
	script := defenderSetScript(req)
	if script == "" {
		return nil, ErrInvalidPayload
	}
	if err := defenderRunScript(90*time.Second, script); err != nil {
		return nil, err
	}
	return &DefenderWriteResult{Applied: defenderApplied(req)}, nil
}

func StartDefenderScan(req DefenderScanRequest) (*DefenderScanResult, error) {
	if err := startDefenderScanPS(req); err != nil {
		if req.Type == "offline" {
			return nil, err
		}
		if err2 := startDefenderScanMpCmdRun(req.Type); err2 != nil {
			return nil, err
		}
		return &DefenderScanResult{Started: true, Type: req.Type, Source: "mpcmdrun"}, nil
	}
	return &DefenderScanResult{Started: true, Type: req.Type}, nil
}

func UpdateDefender() (map[string]any, error) {
	if err := defenderRunScript(10*time.Minute, defenderTryScript("Update-MpSignature")); err != nil {
		if _, err2 := defenderMpCmdRun("-SignatureUpdate"); err2 != nil {
			return nil, err
		}
		return map[string]any{"started": true, "action": "update_signatures", "source": "mpcmdrun"}, nil
	}
	return map[string]any{"started": true, "action": "update_signatures"}, nil
}

func CancelDefenderScan() (map[string]any, error) {
	if err := defenderRunScript(60*time.Second, defenderTryScript("Stop-MpScan")); err != nil {
		return nil, err
	}
	return map[string]any{"cancelled": true, "action": "cancel_scan"}, nil
}

func DefenderThreatAction(req DefenderActionRequest) (*DefenderActionResult, error) {
	if err := defenderRunScript(90*time.Second, defenderThreatScript(req)); err != nil {
		return nil, err
	}
	return &DefenderActionResult{ThreatID: req.ThreatID, Action: req.Action}, nil
}

func startDefenderScanPS(req DefenderScanRequest) error {
	var action string
	switch req.Type {
	case "full":
		action = "Start-MpScan -ScanType FullScan"
	case "offline":
		action = "Start-MpWDOScan"
	default:
		action = "Start-MpScan -ScanType QuickScan"
	}
	return defenderRunScript(60*time.Second, defenderTryScript(action))
}

func startDefenderScanMpCmdRun(scanType string) error {
	scanArg := "1"
	if scanType == "full" {
		scanArg = "2"
	}
	_, err := defenderMpCmdRun("-Scan", "-ScanType", scanArg)
	return err
}

func defenderMpCmdRun(args ...string) (string, error) {
	raw, err := runHiddenInSession(5*time.Minute, system32("MpCmdRun.exe"), args...)
	return raw, mapMpCmdRunErr(raw, err)
}

func mapMpCmdRunErr(raw string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrNoSession) {
		return fmt.Errorf("defender_no_interactive_session")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("defender_failed: mpcmdrun timed out")
	}
	low := strings.ToLower(raw + " " + errString(err))
	if strings.Contains(low, "access") {
		return ErrDefenderAccess
	}
	msg := strings.TrimSpace(raw)
	if msg != "" {
		return fmt.Errorf("defender_failed: %s", clipMessage(msg))
	}
	return fmt.Errorf("defender_failed: mpcmdrun exit")
}

func defenderRunScript(timeout time.Duration, script string) error {
	raw, err := runDefenderPS(timeout, script)
	if err != nil {
		return err
	}
	if !defenderOutputOK(raw) {
		trim := strings.TrimSpace(raw)
		if trim != "" {
			return fmt.Errorf("defender_failed: %s", clipMessage(trim))
		}
		return fmt.Errorf("defender_set_failed")
	}
	return nil
}

func defenderOutputOK(raw string) bool {
	return strings.Contains(strings.ToLower(raw), "ok")
}

func runDefenderPS(timeout time.Duration, script string) (string, error) {
	if strings.TrimSpace(script) == "" {
		return "", ErrInvalidPayload
	}
	raw, err := runHiddenInSession(timeout, powershellExe(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	return raw, mapDefenderPSErr(raw, err)
}

func defenderTryScript(action string) string {
	return `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Import-Module Defender -ErrorAction Stop; try { ` + action + `; Write-Output 'ok' } catch { Write-Output ('ERR:' + $_.Exception.Message); exit 1 }`
}

func defenderThreatScript(req DefenderActionRequest) string {
	id := powershellQuote(req.ThreatID)
	var action string
	switch req.Action {
	case "restore":
		action = "Restore-MpThreat -ThreatID " + id
	case "allow":
		action = "Set-MpPreference -ThreatIDDefaultAction_Ids " + id + " -ThreatIDDefaultAction_Actions 6"
	case "quarantine":
		action = "Remove-MpThreat -ThreatID " + id
	default:
		action = "Remove-MpThreat -ThreatID " + id
	}
	return defenderTryScript(action)
}

func mapDefenderPSErr(raw string, err error) error {
	if errors.Is(err, ErrNoSession) {
		return fmt.Errorf("defender_no_interactive_session")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("defender_failed: command timed out")
	}
	low := strings.ToLower(raw + " " + errString(err))
	if strings.Contains(low, "tamper") {
		return fmt.Errorf("tamper_protection_blocks_preference")
	}
	if isAccessDenied(err) || strings.Contains(low, "access is denied") || strings.Contains(low, "access denied") {
		return ErrDefenderAccess
	}
	for _, line := range strings.Split(raw, "\n") {
		trim := strings.TrimSpace(line)
		if len(trim) >= 4 && strings.EqualFold(trim[:4], "ERR:") {
			msg := strings.TrimSpace(trim[4:])
			if msg != "" {
				return fmt.Errorf("defender_failed: %s", clipMessage(msg))
			}
		}
	}
	if err != nil {
		msg := strings.TrimSpace(raw)
		if msg != "" {
			return fmt.Errorf("defender_failed: %s", clipMessage(msg))
		}
		return err
	}
	return nil
}

func defenderSetScript(req DefenderWriteRequest) string {
	var parts []string
	if req.Realtime != nil {
		parts = append(parts, "Set-MpPreference -DisableRealtimeMonitoring "+psBool(!*req.Realtime))
	}
	if req.Behavior != nil {
		parts = append(parts, "Set-MpPreference -DisableBehaviorMonitoring "+psBool(!*req.Behavior))
	}
	if req.IOAV != nil {
		parts = append(parts, "Set-MpPreference -DisableIOAVProtection "+psBool(!*req.IOAV))
	}
	if req.ScriptScanning != nil {
		parts = append(parts, "Set-MpPreference -DisableScriptScanning "+psBool(!*req.ScriptScanning))
	}
	if req.CloudProtection != "" {
		n := "0"
		if req.CloudProtection == "basic" {
			n = "1"
		} else if req.CloudProtection == "advanced" {
			n = "2"
		}
		parts = append(parts, "Set-MpPreference -MAPSReporting "+n)
	}
	if req.PUA != nil {
		n := "0"
		if *req.PUA {
			n = "1"
		}
		parts = append(parts, "Set-MpPreference -PUAProtection "+n)
	}
	if req.NetworkProtection != "" {
		n := "0"
		if req.NetworkProtection == "enabled" {
			n = "1"
		} else if req.NetworkProtection == "audit" {
			n = "2"
		}
		parts = append(parts, "Set-MpPreference -EnableNetworkProtection "+n)
	}
	if req.ControlledFolderAccess != "" {
		n := "0"
		if req.ControlledFolderAccess == "enabled" {
			n = "1"
		} else if req.ControlledFolderAccess == "audit" {
			n = "2"
		}
		parts = append(parts, "Set-MpPreference -EnableControlledFolderAccess "+n)
	}
	if len(parts) == 0 {
		return ""
	}
	body := strings.Join(parts, "; ")
	return `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Import-Module Defender -ErrorAction Stop; try { ` + body + `; Write-Output 'ok' } catch { Write-Output ('ERR:' + $_.Exception.Message); exit 1 }`
}

func defenderApplied(req DefenderWriteRequest) []string {
	var out []string
	if req.Realtime != nil {
		out = append(out, "realtime")
	}
	if req.Behavior != nil {
		out = append(out, "behavior")
	}
	if req.IOAV != nil {
		out = append(out, "ioav")
	}
	if req.ScriptScanning != nil {
		out = append(out, "scriptScanning")
	}
	if req.CloudProtection != "" {
		out = append(out, "cloudProtection")
	}
	if req.PUA != nil {
		out = append(out, "pua")
	}
	if req.NetworkProtection != "" {
		out = append(out, "networkProtection")
	}
	if req.ControlledFolderAccess != "" {
		out = append(out, "controlledFolderAccess")
	}
	return out
}

func psBool(v bool) string {
	if v {
		return "$true"
	}
	return "$false"
}

func powershellQuote(v string) string {
	return "'" + strings.ReplaceAll(v, "'", "''") + "'"
}
