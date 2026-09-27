package winops

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

func threatStatusName(v int) string {
	switch v {
	case 1:
		return "detected"
	case 2:
		return "cleaned"
	case 3:
		return "quarantined"
	case 4:
		return "removed"
	case 5:
		return "allowed"
	case 6:
		return "blocked"
	case 8:
		return "clean_failed"
	case 9:
		return "quarantine_failed"
	case 10:
		return "remove_failed"
	case 11:
		return "allow_failed"
	case 12:
		return "abandoned"
	case 13:
		return "block_failed"
	default:
		if v == 0 {
			return "unknown"
		}
		return strconv.Itoa(v)
	}
}

func threatActive(status string) bool {
	switch status {
	case "detected", "quarantined", "clean_failed", "quarantine_failed", "remove_failed", "abandoned":
		return true
	default:
		return false
	}
}

func cloudBlockName(v int) string {
	switch v {
	case 0:
		return "default"
	case 1:
		return "moderate"
	case 2:
		return "high"
	case 4:
		return "high_plus"
	case 6:
		return "zero_tolerance"
	default:
		return ""
	}
}

func submitSamplesName(v int) string {
	switch v {
	case 0:
		return "prompt"
	case 1:
		return "safe"
	case 2:
		return "never"
	case 3:
		return "always"
	default:
		return ""
	}
}

func asrActionName(v int) string {
	switch v {
	case 1:
		return "block"
	case 2:
		return "audit"
	case 6:
		return "warn"
	default:
		return "not_configured"
	}
}

func asrRuleName(id string) string {
	switch strings.ToLower(strings.TrimSpace(id)) {
	case "56a863a9-875e-4185-98a7-b882c64b5ce5":
		return "block_vulnerable_driver"
	case "7674ba52-37eb-4a4f-a9a1-f0f9a1619a2c":
		return "block_adobe_child"
	case "d4f940ab-401b-4efc-aadc-ad5f3c50688a":
		return "block_office_child"
	case "9e6c4e1f-7d60-472f-ba1a-a39ef669e4b2":
		return "block_stolen_token"
	case "be9ba2d9-53ea-4cdc-84e5-9b1eeee46550":
		return "block_executable_email"
	case "5beb7efe-fd9a-4556-801d-275e5ffc04cc":
		return "block_obfuscated_script"
	case "d3e037e1-3eb8-44c8-a917-57927947596d":
		return "block_js_launching_exe"
	case "3b576869-a4ec-4529-8536-b80a7769e899":
		return "block_office_executable"
	case "75668c1f-73b5-4cf0-bb93-3ecf5cb7cc84":
		return "block_office_injection"
	case "26190899-1602-49e8-8b27-eb1d0a1ce869":
		return "block_wmi_persistence"
	case "e6db77e5-3df2-4cf1-b95a-636979351e5b":
		return "block_psexec"
	case "d1e49aac-8f56-4280-b9ba-993a6d77406c":
		return "block_unsigned_ps_exec"
	case "b2b3f03d-6a65-4f7b-a9c7-1c7ef74a9ba4":
		return "block_untrusted_usb"
	case "92e97fa1-2edf-4476-bdd6-9dd0b4dddc7b":
		return "block_win32_api_from_office"
	case "c1db55ab-c21a-4637-bb3f-a12568109d35":
		return "use_advanced_ransomware"
	default:
		return ""
	}
}

func zipASR(ids []string, actions []int) []ASRRule {
	if len(ids) == 0 {
		return nil
	}
	out := make([]ASRRule, 0, len(ids))
	for i, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		rule := ASRRule{ID: id, Name: asrRuleName(id)}
		if i < len(actions) {
			rule.Action = asrActionName(actions[i])
		}
		out = append(out, rule)
	}
	return out
}

func summarizeThreats(threats []DefenderThreat) (count, active int) {
	count = len(threats)
	for _, t := range threats {
		if threatActive(t.Status) {
			active++
		}
	}
	return count, active
}

func parsePSDate(v any) string {
	switch t := v.(type) {
	case string:
		s := strings.TrimSpace(t)
		if s == "" || s == "null" {
			return ""
		}
		if strings.HasPrefix(s, "/Date(") {
			num := strings.TrimSuffix(strings.TrimPrefix(s, "/Date("), ")/")
			num = strings.TrimSuffix(num, "+0000")
			ms, err := strconv.ParseInt(strings.TrimSuffix(strings.Split(num, "-")[0], "+"), 10, 64)
			if err != nil {
				return ""
			}
			return time.UnixMilli(ms).UTC().Format(time.RFC3339)
		}
		if ts, err := time.Parse(time.RFC3339, s); err == nil {
			return ts.UTC().Format(time.RFC3339)
		}
		if ts, err := time.Parse("2006-01-02T15:04:05", s); err == nil {
			return ts.UTC().Format(time.RFC3339)
		}
		return parseCIMDate(s)
	case float64:
		if t > 1e12 {
			return time.UnixMilli(int64(t)).UTC().Format(time.RFC3339)
		}
		if t > 1e9 {
			return time.Unix(int64(t), 0).UTC().Format(time.RFC3339)
		}
	}
	return ""
}

func jsonBool(m map[string]any, keys ...string) bool {
	for _, k := range keys {
		switch v := m[k].(type) {
		case bool:
			return v
		case float64:
			return v != 0
		case string:
			s := strings.ToLower(strings.TrimSpace(v))
			return s == "true" || s == "1"
		}
	}
	return false
}

func jsonString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		switch v := m[k].(type) {
		case string:
			if s := strings.TrimSpace(v); s != "" && s != "<nil>" {
				return s
			}
		case float64:
			if v != 0 {
				return strconv.FormatInt(int64(v), 10)
			}
		case map[string]any:
			if s := jsonString(v, "DisplayName", "Value", "value"); s != "" {
				return s
			}
		}
	}
	return ""
}

func jsonIntPtr(m map[string]any, keys ...string) *int {
	for _, k := range keys {
		switch v := m[k].(type) {
		case float64:
			n := int(v)
			if n < 0 || n > 36500 {
				return nil
			}
			return &n
		case string:
			n, err := strconv.Atoi(strings.TrimSpace(v))
			if err != nil || n < 0 || n > 36500 {
				return nil
			}
			return &n
		}
	}
	return nil
}

func jsonInt(m map[string]any, keys ...string) int {
	for _, k := range keys {
		switch v := m[k].(type) {
		case float64:
			return int(v)
		case int:
			return v
		case string:
			n, _ := strconv.Atoi(strings.TrimSpace(v))
			return n
		case map[string]any:
			if n := jsonInt(v, "value", "Value"); n != 0 {
				return n
			}
		}
	}
	return 0
}

func jsonStringSlice(v any) []string {
	switch t := v.(type) {
	case []any:
		out := make([]string, 0, len(t))
		for _, item := range t {
			s := strings.TrimSpace(asString(item))
			if s != "" && s != "<nil>" {
				out = append(out, s)
			}
			if len(out) >= 40 {
				break
			}
		}
		return out
	case []string:
		out := make([]string, 0, len(t))
		for _, s := range t {
			s = strings.TrimSpace(s)
			if s == "" {
				continue
			}
			out = append(out, s)
			if len(out) >= 40 {
				break
			}
		}
		return out
	case string:
		if t == "" {
			return nil
		}
		return []string{t}
	}
	return nil
}

func jsonIntSlice(v any) []int {
	switch t := v.(type) {
	case []any:
		out := make([]int, 0, len(t))
		for _, item := range t {
			switch n := item.(type) {
			case float64:
				out = append(out, int(n))
			case string:
				if i, err := strconv.Atoi(strings.TrimSpace(n)); err == nil {
					out = append(out, i)
				}
			}
		}
		return out
	}
	return nil
}

func asString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatInt(int64(t), 10)
	default:
		if t == nil {
			return ""
		}
		return strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(stringify(t), ""), ""))
	}
}

func stringify(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

func parseDefenderPS(raw string) *DefenderStatus {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var blob map[string]any
	if json.Unmarshal([]byte(raw), &blob) != nil {
		return parseDefenderPSTagged(raw)
	}
	st := asMap(blob["status"])
	if st == nil {
		st = blob
	}
	if !defenderStatusPresent(st) {
		return nil
	}
	out := statusFromJSON(st)
	if pref := asMap(blob["pref"]); pref != nil {
		out.Preferences = prefFromJSON(pref)
	}
	threats, truncated := threatsFromJSON(blob["threats"])
	out.Threats = threats
	out.ThreatsTruncated = truncated
	out.ThreatCount, out.ActiveThreatCount = summarizeThreats(out.Threats)
	out.Source = "powershell"
	out.Available = true
	fillScanProgress(out)
	return out
}

func parseDefenderPSTagged(raw string) *DefenderStatus {
	var statusJSON, prefJSON, threatJSON string
	for _, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "STATUS:"):
			statusJSON = strings.TrimPrefix(line, "STATUS:")
		case strings.HasPrefix(line, "PREF:"):
			prefJSON = strings.TrimPrefix(line, "PREF:")
		case strings.HasPrefix(line, "THREAT:"):
			threatJSON = strings.TrimPrefix(line, "THREAT:")
		}
	}
	if statusJSON == "" {
		return nil
	}
	var st map[string]any
	if json.Unmarshal([]byte(statusJSON), &st) != nil {
		return nil
	}
	if !defenderStatusPresent(st) {
		return nil
	}
	out := statusFromJSON(st)
	if prefJSON != "" {
		var pref map[string]any
		if json.Unmarshal([]byte(prefJSON), &pref) == nil {
			out.Preferences = prefFromJSON(pref)
		}
	}
	if threatJSON != "" {
		var raw any
		if json.Unmarshal([]byte(threatJSON), &raw) == nil {
			out.Threats, out.ThreatsTruncated = threatsFromJSON(raw)
		}
	}
	out.ThreatCount, out.ActiveThreatCount = summarizeThreats(out.Threats)
	out.Source = "powershell"
	out.Available = true
	fillScanProgress(out)
	return out
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func defenderStatusPresent(m map[string]any) bool {
	if m == nil || len(m) == 0 {
		return false
	}
	if _, errOnly := m["error"]; errOnly && len(m) == 1 {
		return false
	}
	for _, k := range []string{
		"AntivirusEnabled",
		"RealTimeProtectionEnabled",
		"AntispywareEnabled",
		"AMEngineVersion",
		"AntivirusSignatureVersion",
		"AMProductVersion",
		"ComputerState",
		"antivirusEnabled",
		"realtimeProtectionEnabled",
	} {
		if _, ok := m[k]; ok {
			return true
		}
	}
	return false
}

func statusFromJSON(m map[string]any) *DefenderStatus {
	out := &DefenderStatus{
		AntivirusEnabled:            jsonBool(m, "AntivirusEnabled"),
		AntispywareEnabled:          jsonBool(m, "AntispywareEnabled"),
		RealtimeProtectionEnabled:   jsonBool(m, "RealTimeProtectionEnabled"),
		IoavProtectionEnabled:       jsonBool(m, "IoavProtectionEnabled"),
		NISEnabled:                  jsonBool(m, "NISEnabled"),
		AMServiceEnabled:            jsonBool(m, "AMServiceEnabled"),
		OnAccessProtectionEnabled:   jsonBool(m, "OnAccessProtectionEnabled"),
		BehaviorMonitorEnabled:      jsonBool(m, "BehaviorMonitorEnabled"),
		AntivirusSignatureVersion:   jsonString(m, "AntivirusSignatureVersion"),
		AntivirusSignatureAge:       jsonIntPtr(m, "AntivirusSignatureAge"),
		AntivirusSignatureUpdated:   parsePSDate(m["AntivirusSignatureLastUpdated"]),
		AntispywareSignatureVersion: jsonString(m, "AntispywareSignatureVersion"),
		NISSignatureVersion:         jsonString(m, "NISSignatureVersion"),
		AMEngineVersion:             firstNonEmpty(jsonString(m, "AMEngineVersion"), jsonString(m, "AntivirusSignatureVersion")),
		ProductVersion:              jsonString(m, "AMProductVersion"),
		ServiceVersion:              jsonString(m, "AMServiceVersion"),
		QuickScanAge:                jsonIntPtr(m, "QuickScanAge"),
		FullScanAge:                 jsonIntPtr(m, "FullScanAge"),
		ComputerState:               defenderComputerState(jsonInt(m, "ComputerState")),
		LastQuickScan:               firstNonEmpty(parsePSDate(m["QuickScanEndTime"]), parsePSDate(m["LastQuickScanTimeStamp"])),
		LastFullScan:                firstNonEmpty(parsePSDate(m["FullScanEndTime"]), parsePSDate(m["LastFullScanTimeStamp"])),
		LastQuickScanStart:          parsePSDate(m["QuickScanStartTime"]),
		LastFullScanStart:           parsePSDate(m["FullScanStartTime"]),
		TamperProtected:             jsonBool(m, "IsTamperProtected", "TamperProtected"),
		IsVirtualMachine:            jsonBool(m, "IsVirtualMachine"),
		DefenderSignaturesOutOfDate: jsonBool(m, "DefenderSignaturesOutOfDate"),
		FullScanOverdue:             jsonBool(m, "FullScanOverdue"),
		QuickScanOverdue:            jsonBool(m, "QuickScanOverdue"),
		RebootRequired:              jsonBool(m, "RebootRequired"),
	}
	return out
}

func prefFromJSON(m map[string]any) *DefenderPreferences {
	return &DefenderPreferences{
		RealtimeMonitoring:     !jsonBool(m, "DisableRealtimeMonitoring"),
		BehaviorMonitoring:     !jsonBool(m, "DisableBehaviorMonitoring"),
		IOAVProtection:         !jsonBool(m, "DisableIOAVProtection"),
		ScriptScanning:         !jsonBool(m, "DisableScriptScanning"),
		CloudProtection:        mapsName(jsonInt(m, "MAPSReporting")),
		CloudBlockLevel:        cloudBlockName(jsonInt(m, "CloudBlockLevel")),
		SubmitSamples:          submitSamplesName(jsonInt(m, "SubmitSamplesConsent")),
		PUAProtection:          onOffAudit(jsonInt(m, "PUAProtection")),
		NetworkProtection:      onOffAudit(jsonInt(m, "EnableNetworkProtection")),
		ControlledFolderAccess: onOffAudit(jsonInt(m, "EnableControlledFolderAccess")),
		ASRRules:               zipASR(jsonStringSlice(m["AttackSurfaceReductionRules_Ids"]), jsonIntSlice(m["AttackSurfaceReductionRules_Actions"])),
		ExclusionPaths:         jsonStringSlice(m["ExclusionPath"]),
		ExclusionExtensions:    jsonStringSlice(m["ExclusionExtension"]),
		ExclusionProcesses:     jsonStringSlice(m["ExclusionProcess"]),
	}
}

func threatsFromJSON(v any) ([]DefenderThreat, bool) {
	var items []any
	switch t := v.(type) {
	case []any:
		items = t
	case map[string]any:
		items = []any{t}
	default:
		return nil, false
	}
	out := []DefenderThreat{}
	truncated := false
	for _, item := range items {
		m := asMap(item)
		if m == nil {
			continue
		}
		if len(out) >= maxThreats {
			truncated = true
			break
		}
		id := jsonString(m, "ThreatID", "ThreatId")
		name := jsonString(m, "ThreatName", "Name")
		if id == "" && name == "" {
			continue
		}
		if name == "" {
			name = id
		}
		if id == "" {
			id = name
		}
		status := threatStatusName(jsonInt(m, "ThreatStatusID", "ThreatStatusId"))
		out = append(out, DefenderThreat{
			ID:            id,
			InstanceID:    jsonString(m, "InstanceID", "InstanceId"),
			Name:          name,
			Severity:      threatSeverity(jsonInt(m, "SeverityID", "SeverityId")),
			Status:        status,
			Resources:     jsonStringSlice(m["Resources"]),
			DetectionTime: firstNonEmpty(parsePSDate(m["InitialDetectionTime"]), parsePSDate(m["LastThreatStatusChangeTime"])),
			Action:        threatActionName(jsonInt(m, "ActionID", "ActionId")),
			Process:       jsonString(m, "ProcessName"),
			User:          jsonString(m, "DomainUser"),
		})
	}
	return out, truncated
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func fillScanProgress(st *DefenderStatus) {
	if st == nil {
		return
	}
	switch st.ComputerState {
	case "pending_full_scan":
		st.ScanInProgress = true
		if st.ScanType == "" {
			st.ScanType = "full"
		}
	case "pending_offline_scan":
		st.ScanInProgress = true
		if st.ScanType == "" {
			st.ScanType = "offline"
		}
	}
	if st.LastQuickScanStart != "" && (st.LastQuickScan == "" || st.LastQuickScanStart > st.LastQuickScan) {
		st.ScanInProgress = true
		st.ScanType = "quick"
	}
	if st.LastFullScanStart != "" && (st.LastFullScan == "" || st.LastFullScanStart > st.LastFullScan) {
		st.ScanInProgress = true
		st.ScanType = "full"
	}
}
