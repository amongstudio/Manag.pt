package winops

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	WACServiceName = "ServerManagementGateway"
	maxLogName     = 256
	maxNewest      = 200
	defaultNewest  = 50
	maxMessage     = 400
	maxEvents      = 200
	maxPending     = 100
	maxHistory     = 50
	maxKB          = 16
)

var kbArticle = regexp.MustCompile(`^KB\d{4,10}$`)

var (
	ErrUnsupported          = errors.New("unsupported")
	ErrInvalidPayload       = errors.New("invalid_windows_payload")
	ErrAccessDenied         = errors.New("event_log_access_denied")
	ErrQueryFailed          = errors.New("event_log_query_failed")
	ErrWUAPI                = errors.New("wuapi_unavailable")
	ErrNoSession            = errors.New("no_interactive_session")
	ErrAssistNotFound       = errors.New("quick_assist_not_found")
	ErrAssistRefused        = errors.New("quick_assist_refused")
	ErrWACAccessDenied      = errors.New("wac_access_denied")
	ErrTaskAccessDenied     = errors.New("task_access_denied")
	ErrTaskNotFound         = errors.New("task_not_found")
	ErrDefenderAccess       = errors.New("defender_access_denied")
	ErrDefenderUnavailable  = errors.New("defender_unavailable")
	ErrBitLockerAccess      = errors.New("bitlocker_access_denied")
	ErrBitLockerUnavailable = errors.New("bitlocker_unavailable")
	ErrBitLockerFailed      = errors.New("bitlocker_action_failed")
	ErrDismAccessDenied     = errors.New("dism_access_denied")
	ErrDismUnavailable      = errors.New("dism_unavailable")
	ErrSmbAccessDenied      = errors.New("smb_access_denied")
	ErrSmbNotFound          = errors.New("smb_not_found")
	ErrCredAccessDenied     = errors.New("credential_access_denied")
	ErrCredNotFound         = errors.New("credential_not_found")
)

type EventLogRequest struct {
	Log     string
	Newest  int
	Level   string
	EventID int
	Source  string
	Since   string
	Until   string
}

type EventEntry struct {
	Time    string `json:"time"`
	Type    string `json:"type"`
	Source  string `json:"source"`
	ID      uint32 `json:"id"`
	Message string `json:"message,omitempty"`
	Channel string `json:"channel,omitempty"`
}

type EventLogResult struct {
	Log       string       `json:"log"`
	Entries   []EventEntry `json:"entries"`
	Truncated bool         `json:"truncated"`
}

type UpdateRequest struct {
	Online bool
}

type UpdateItem struct {
	Title          string   `json:"title"`
	KB             []string `json:"kb,omitempty"`
	Severity       string   `json:"severity,omitempty"`
	IsDownloaded   bool     `json:"isDownloaded,omitempty"`
	RebootRequired bool     `json:"rebootRequired,omitempty"`
	Date           string   `json:"date,omitempty"`
	Result         string   `json:"result,omitempty"`
}

type UpdateResult struct {
	Pending   []UpdateItem `json:"pending"`
	Installed []UpdateItem `json:"installed"`
	Online    bool         `json:"online"`
	Truncated bool         `json:"truncated"`
}

type AssistRequest struct {
	App string
}

type AssistResult struct {
	Started bool   `json:"started"`
	App     string `json:"app"`
	Path    string `json:"path,omitempty"`
}

type AdminCenterResult struct {
	Name        string `json:"name"`
	Installed   bool   `json:"installed"`
	Running     bool   `json:"running"`
	StartType   string `json:"startType,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	Port        int    `json:"port,omitempty"`
	URL         string `json:"url,omitempty"`
}

const (
	maxTaskPath      = 512
	maxTaskQuery     = 256
	maxTasks         = 1500
	maxCapabilities  = 500
	maxQuery         = 256
	maxThreats       = 80
	MediaFeaturePack = "Media.MediaFeaturePack~~~~0.0.1.0"
)

type TasksRequest struct {
	Query string
}

type ScheduledTask struct {
	Name           string `json:"name"`
	Path           string `json:"path"`
	Enabled        bool   `json:"enabled"`
	State          string `json:"state,omitempty"`
	LastRunTime    string `json:"lastRunTime,omitempty"`
	NextRunTime    string `json:"nextRunTime,omitempty"`
	LastTaskResult string `json:"lastTaskResult,omitempty"`
	MissedRuns     uint32 `json:"missedRuns,omitempty"`
	Author         string `json:"author,omitempty"`
}

type TaskList struct {
	Tasks     []ScheduledTask `json:"tasks"`
	Truncated bool            `json:"truncated"`
}

type TaskWriteRequest struct {
	Path    string
	Enabled bool
}

type TaskWriteResult struct {
	Path    string `json:"path"`
	Enabled bool   `json:"enabled"`
	Action  string `json:"action"`
}

type DefenderStatus struct {
	Available                   bool                 `json:"available"`
	AntivirusEnabled            bool                 `json:"antivirusEnabled"`
	AntispywareEnabled          bool                 `json:"antispywareEnabled"`
	RealtimeProtectionEnabled   bool                 `json:"realtimeProtectionEnabled"`
	IoavProtectionEnabled       bool                 `json:"ioavProtectionEnabled,omitempty"`
	NISEnabled                  bool                 `json:"nisEnabled,omitempty"`
	AMServiceEnabled            bool                 `json:"amServiceEnabled,omitempty"`
	OnAccessProtectionEnabled   bool                 `json:"onAccessProtectionEnabled,omitempty"`
	BehaviorMonitorEnabled      bool                 `json:"behaviorMonitorEnabled,omitempty"`
	AntivirusSignatureVersion   string               `json:"antivirusSignatureVersion,omitempty"`
	AntivirusSignatureAge       *int                 `json:"antivirusSignatureAge,omitempty"`
	AntivirusSignatureUpdated   string               `json:"antivirusSignatureUpdated,omitempty"`
	AntispywareSignatureVersion string               `json:"antispywareSignatureVersion,omitempty"`
	NISSignatureVersion         string               `json:"nisSignatureVersion,omitempty"`
	AMEngineVersion             string               `json:"amEngineVersion,omitempty"`
	ProductVersion              string               `json:"productVersion,omitempty"`
	ServiceVersion              string               `json:"serviceVersion,omitempty"`
	QuickScanAge                *int                 `json:"quickScanAge,omitempty"`
	FullScanAge                 *int                 `json:"fullScanAge,omitempty"`
	ComputerState               string               `json:"computerState,omitempty"`
	LastQuickScan               string               `json:"lastQuickScan,omitempty"`
	LastFullScan                string               `json:"lastFullScan,omitempty"`
	LastQuickScanStart          string               `json:"lastQuickScanStart,omitempty"`
	LastFullScanStart           string               `json:"lastFullScanStart,omitempty"`
	TamperProtected             bool                 `json:"tamperProtected,omitempty"`
	IsVirtualMachine            bool                 `json:"isVirtualMachine,omitempty"`
	DefenderSignaturesOutOfDate bool                 `json:"defenderSignaturesOutOfDate,omitempty"`
	FullScanOverdue             bool                 `json:"fullScanOverdue,omitempty"`
	QuickScanOverdue            bool                 `json:"quickScanOverdue,omitempty"`
	RebootRequired              bool                 `json:"rebootRequired,omitempty"`
	ThreatCount                 int                  `json:"threatCount,omitempty"`
	ActiveThreatCount           int                  `json:"activeThreatCount,omitempty"`
	ScanInProgress              bool                 `json:"scanInProgress,omitempty"`
	ScanType                    string               `json:"scanType,omitempty"`
	Preferences                 *DefenderPreferences `json:"preferences,omitempty"`
	Threats                     []DefenderThreat     `json:"threats,omitempty"`
	ThreatsTruncated            bool                 `json:"threatsTruncated,omitempty"`
	Source                      string               `json:"source,omitempty"`
}

type DefenderPreferences struct {
	RealtimeMonitoring     bool      `json:"realtimeMonitoring"`
	BehaviorMonitoring     bool      `json:"behaviorMonitoring"`
	IOAVProtection         bool      `json:"ioavProtection"`
	ScriptScanning         bool      `json:"scriptScanning"`
	CloudProtection        string    `json:"cloudProtection,omitempty"`
	CloudBlockLevel        string    `json:"cloudBlockLevel,omitempty"`
	SubmitSamples          string    `json:"submitSamples,omitempty"`
	PUAProtection          string    `json:"puaProtection,omitempty"`
	NetworkProtection      string    `json:"networkProtection,omitempty"`
	ControlledFolderAccess string    `json:"controlledFolderAccess,omitempty"`
	ASRRules               []ASRRule `json:"asrRules,omitempty"`
	ExclusionPaths         []string  `json:"exclusionPaths,omitempty"`
	ExclusionExtensions    []string  `json:"exclusionExtensions,omitempty"`
	ExclusionProcesses     []string  `json:"exclusionProcesses,omitempty"`
}

type ASRRule struct {
	ID     string `json:"id"`
	Name   string `json:"name,omitempty"`
	Action string `json:"action,omitempty"`
}

type DefenderThreat struct {
	ID            string   `json:"id"`
	InstanceID    string   `json:"instanceId,omitempty"`
	Name          string   `json:"name"`
	Severity      string   `json:"severity,omitempty"`
	Status        string   `json:"status,omitempty"`
	Resources     []string `json:"resources,omitempty"`
	DetectionTime string   `json:"detectionTime,omitempty"`
	Action        string   `json:"action,omitempty"`
	Process       string   `json:"process,omitempty"`
	User          string   `json:"user,omitempty"`
}

type DefenderWriteRequest struct {
	Realtime               *bool
	Behavior               *bool
	IOAV                   *bool
	ScriptScanning         *bool
	CloudProtection        string
	PUA                    *bool
	NetworkProtection      string
	ControlledFolderAccess string
}

type DefenderWriteResult struct {
	Applied []string `json:"applied"`
}

type DefenderScanRequest struct {
	Type string
}

type DefenderScanResult struct {
	Started bool   `json:"started"`
	Type    string `json:"type"`
	Source  string `json:"source,omitempty"`
}

type DefenderActionRequest struct {
	ThreatID string
	Action   string
}

type DefenderActionResult struct {
	ThreatID string `json:"threatId"`
	Action   string `json:"action"`
}

type InstallCapabilityRequest struct {
	Name string
}

type InstallCapabilityResult struct {
	Name           string `json:"name"`
	Started        bool   `json:"started"`
	RebootRequired bool   `json:"rebootRequired,omitempty"`
	Output         string `json:"output,omitempty"`
}

type BitLockerKeyProtector struct {
	ID   string `json:"id,omitempty"`
	Type string `json:"type"`
}

type BitLockerVolume struct {
	MountPoint         string                  `json:"mountPoint,omitempty"`
	DeviceID           string                  `json:"deviceId,omitempty"`
	ProtectionStatus   string                  `json:"protectionStatus"`
	ConversionStatus   string                  `json:"conversionStatus,omitempty"`
	EncryptionMethod   string                  `json:"encryptionMethod,omitempty"`
	EncryptionPercent  *int                    `json:"encryptionPercent,omitempty"`
	VolumeType         string                  `json:"volumeType,omitempty"`
	PersistentVolumeID string                  `json:"persistentVolumeId,omitempty"`
	LockStatus         string                  `json:"lockStatus,omitempty"`
	AutoUnlock         *bool                   `json:"autoUnlock,omitempty"`
	EncryptionFlags    string                  `json:"encryptionFlags,omitempty"`
	KeyProtectors      []BitLockerKeyProtector `json:"keyProtectors,omitempty"`
}

type BitLockerResult struct {
	Volumes   []BitLockerVolume `json:"volumes"`
	Available bool              `json:"available"`
	Truncated bool              `json:"truncated"`
	Reason    string            `json:"reason,omitempty"`
}

type BitLockerWriteRequest struct {
	Action           string
	MountPoint       string
	Password         string
	RecoveryPassword string
	ProtectorType    string
	ProtectorID      string
	EncryptionMethod string
	UsedSpaceOnly    bool
	UsedSpaceOnlySet bool
}

type BitLockerWriteResult struct {
	Action           string           `json:"action"`
	MountPoint       string           `json:"mountPoint"`
	Applied          bool             `json:"applied"`
	RecoveryPassword string           `json:"recoveryPassword,omitempty"`
	ProtectorID      string           `json:"protectorId,omitempty"`
	Credentials      []map[string]any `json:"credentials,omitempty"`
	Notes            []string         `json:"notes,omitempty"`
}

type CapabilitiesRequest struct {
	Query string
}

type WindowsCapability struct {
	Name  string `json:"name"`
	State string `json:"state"`
	Kind  string `json:"kind,omitempty"`
}

type CapabilityList struct {
	Capabilities []WindowsCapability `json:"capabilities"`
	Truncated    bool                `json:"truncated"`
}

func ParseEventLog(raw json.RawMessage) (EventLogRequest, error) {
	req := EventLogRequest{Log: "System", Newest: defaultNewest, Level: "all"}
	if len(raw) == 0 || string(raw) == "null" {
		return req, nil
	}
	var body struct {
		Log     string `json:"log"`
		Newest  int    `json:"newest"`
		Level   string `json:"level"`
		EventID int    `json:"eventId"`
		Source  string `json:"source"`
		Since   string `json:"since"`
		Until   string `json:"until"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return EventLogRequest{}, ErrInvalidPayload
	}
	logName, err := normalizeLog(body.Log)
	if err != nil {
		return EventLogRequest{}, err
	}
	req.Log = logName
	if body.Newest != 0 {
		if body.Newest < 1 || body.Newest > maxNewest {
			return EventLogRequest{}, ErrInvalidPayload
		}
		req.Newest = body.Newest
	}
	level, err := normalizeLevel(body.Level)
	if err != nil {
		return EventLogRequest{}, err
	}
	req.Level = level
	if body.EventID < 0 || body.EventID > 65535 {
		return EventLogRequest{}, ErrInvalidPayload
	}
	req.EventID = body.EventID
	source, err := normalizeSource(body.Source)
	if err != nil {
		return EventLogRequest{}, err
	}
	req.Source = source
	since, err := normalizeTime(body.Since)
	if err != nil {
		return EventLogRequest{}, err
	}
	until, err := normalizeTime(body.Until)
	if err != nil {
		return EventLogRequest{}, err
	}
	req.Since = since
	req.Until = until
	return req, nil
}

func ParseInstallUpdate(raw json.RawMessage) ([]string, string, error) {
	var body struct {
		KBs    []string `json:"kbs"`
		Reboot string   `json:"reboot"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, "", ErrInvalidPayload
	}
	if len(body.KBs) == 0 || len(body.KBs) > 40 {
		return nil, "", ErrInvalidPayload
	}
	out := make([]string, 0, len(body.KBs))
	seen := map[string]struct{}{}
	for _, kb := range body.KBs {
		kb = strings.ToUpper(strings.TrimSpace(kb))
		if !kbArticle.MatchString(kb) {
			return nil, "", ErrInvalidPayload
		}
		if _, ok := seen[kb]; ok {
			continue
		}
		seen[kb] = struct{}{}
		out = append(out, kb)
	}
	reboot := strings.ToLower(strings.TrimSpace(body.Reboot))
	switch reboot {
	case "", "never":
		reboot = "never"
	case "if_required", "scheduled":
	default:
		return nil, "", ErrInvalidPayload
	}
	return out, reboot, nil
}

func ParseUpdate(raw json.RawMessage) (UpdateRequest, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return UpdateRequest{}, nil
	}
	var body struct {
		Online bool `json:"online"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return UpdateRequest{}, ErrInvalidPayload
	}
	return UpdateRequest{Online: body.Online}, nil
}

func ParseAssist(raw json.RawMessage) (AssistRequest, error) {
	req := AssistRequest{App: "quickassist"}
	if len(raw) == 0 || string(raw) == "null" {
		return req, nil
	}
	var body struct {
		App string `json:"app"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return AssistRequest{}, ErrInvalidPayload
	}
	app, err := normalizeApp(body.App)
	if err != nil {
		return AssistRequest{}, err
	}
	req.App = app
	return req, nil
}

func ParseTasks(raw json.RawMessage) (TasksRequest, error) {
	var req TasksRequest
	if len(raw) == 0 || string(raw) == "null" {
		return req, nil
	}
	var body struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return TasksRequest{}, ErrInvalidPayload
	}
	q, err := optionalQuery(body.Query, maxTaskQuery)
	if err != nil {
		return TasksRequest{}, err
	}
	req.Query = q
	return req, nil
}

func ParseTaskEnabled(raw json.RawMessage) (TaskWriteRequest, error) {
	var body struct {
		Path    string `json:"path"`
		Enabled *bool  `json:"enabled"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return TaskWriteRequest{}, ErrInvalidPayload
	}
	if body.Enabled == nil {
		return TaskWriteRequest{}, ErrInvalidPayload
	}
	path, err := ValidateTaskPath(body.Path)
	if err != nil {
		return TaskWriteRequest{}, err
	}
	return TaskWriteRequest{Path: path, Enabled: *body.Enabled}, nil
}

func ParseCapabilities(raw json.RawMessage) (CapabilitiesRequest, error) {
	var req CapabilitiesRequest
	if len(raw) == 0 || string(raw) == "null" {
		return req, nil
	}
	var body struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return CapabilitiesRequest{}, ErrInvalidPayload
	}
	q, err := optionalQuery(body.Query, maxQuery)
	if err != nil {
		return CapabilitiesRequest{}, err
	}
	req.Query = q
	return req, nil
}

func ParseInstallCapability(raw json.RawMessage) (InstallCapabilityRequest, error) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return InstallCapabilityRequest{}, ErrInvalidPayload
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = MediaFeaturePack
	}
	if utf8.RuneCountInString(name) > 256 || strings.ContainsAny(name, "\r\n\x00") {
		return InstallCapabilityRequest{}, ErrInvalidPayload
	}
	if !AllowedCapabilityInstall(name) {
		return InstallCapabilityRequest{}, ErrInvalidPayload
	}
	return InstallCapabilityRequest{Name: name}, nil
}

func AllowedCapabilityInstall(name string) bool {
	n := strings.TrimSpace(name)
	return strings.EqualFold(n, MediaFeaturePack) || strings.HasPrefix(strings.ToLower(n), "media.mediafeaturepack")
}

func ParseDefenderWrite(raw json.RawMessage) (DefenderWriteRequest, error) {
	var body struct {
		Realtime               *bool  `json:"realtime"`
		Behavior               *bool  `json:"behavior"`
		IOAV                   *bool  `json:"ioav"`
		ScriptScanning         *bool  `json:"scriptScanning"`
		CloudProtection        string `json:"cloudProtection"`
		PUA                    *bool  `json:"pua"`
		NetworkProtection      string `json:"networkProtection"`
		ControlledFolderAccess string `json:"controlledFolderAccess"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return DefenderWriteRequest{}, ErrInvalidPayload
	}
	cloud, err := optionalEnum(body.CloudProtection, "disabled", "basic", "advanced")
	if err != nil {
		return DefenderWriteRequest{}, err
	}
	netp, err := optionalEnum(body.NetworkProtection, "disabled", "enabled", "audit")
	if err != nil {
		return DefenderWriteRequest{}, err
	}
	cfa, err := optionalEnum(body.ControlledFolderAccess, "disabled", "enabled", "audit")
	if err != nil {
		return DefenderWriteRequest{}, err
	}
	req := DefenderWriteRequest{
		Realtime:               body.Realtime,
		Behavior:               body.Behavior,
		IOAV:                   body.IOAV,
		ScriptScanning:         body.ScriptScanning,
		CloudProtection:        cloud,
		PUA:                    body.PUA,
		NetworkProtection:      netp,
		ControlledFolderAccess: cfa,
	}
	if req.Realtime == nil && req.Behavior == nil && req.IOAV == nil && req.ScriptScanning == nil &&
		req.CloudProtection == "" && req.PUA == nil && req.NetworkProtection == "" && req.ControlledFolderAccess == "" {
		return DefenderWriteRequest{}, ErrInvalidPayload
	}
	return req, nil
}

func ParseDefenderScan(raw json.RawMessage) (DefenderScanRequest, error) {
	req := DefenderScanRequest{Type: "quick"}
	if len(raw) == 0 || string(raw) == "null" {
		return req, nil
	}
	var body struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return DefenderScanRequest{}, ErrInvalidPayload
	}
	switch strings.ToLower(strings.TrimSpace(body.Type)) {
	case "", "quick":
		req.Type = "quick"
	case "full":
		req.Type = "full"
	case "offline":
		req.Type = "offline"
	default:
		return DefenderScanRequest{}, ErrInvalidPayload
	}
	return req, nil
}

func ParseDefenderAction(raw json.RawMessage) (DefenderActionRequest, error) {
	var body struct {
		ThreatID string `json:"threatId"`
		Action   string `json:"action"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return DefenderActionRequest{}, ErrInvalidPayload
	}
	id := strings.TrimSpace(body.ThreatID)
	if id == "" || utf8.RuneCountInString(id) > 128 || strings.ContainsAny(id, "\r\n\x00") {
		return DefenderActionRequest{}, ErrInvalidPayload
	}
	action := strings.ToLower(strings.TrimSpace(body.Action))
	switch action {
	case "remove", "quarantine", "restore", "allow":
	default:
		return DefenderActionRequest{}, ErrInvalidPayload
	}
	return DefenderActionRequest{ThreatID: id, Action: action}, nil
}

func ParseBitLockerWrite(raw json.RawMessage) (BitLockerWriteRequest, error) {
	var body struct {
		Action           string `json:"action"`
		MountPoint       string `json:"mountPoint"`
		Password         string `json:"password"`
		RecoveryPassword string `json:"recoveryPassword"`
		ProtectorType    string `json:"protectorType"`
		ProtectorID      string `json:"protectorId"`
		EncryptionMethod string `json:"encryptionMethod"`
		UsedSpaceOnly    *bool  `json:"usedSpaceOnly"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return BitLockerWriteRequest{}, ErrInvalidPayload
	}
	action := strings.ToLower(strings.TrimSpace(body.Action))
	switch action {
	case "protect", "unprotect", "lock", "unlock", "suspend", "resume", "add_protector", "remove_protector", "backup_key":
	default:
		return BitLockerWriteRequest{}, ErrInvalidPayload
	}
	mount, err := normalizeMountPoint(body.MountPoint)
	if err != nil {
		return BitLockerWriteRequest{}, err
	}
	ptype := strings.ToLower(strings.TrimSpace(body.ProtectorType))
	switch ptype {
	case "", "tpm", "password", "recovery":
	default:
		return BitLockerWriteRequest{}, ErrInvalidPayload
	}
	method := strings.ToLower(strings.TrimSpace(body.EncryptionMethod))
	switch method {
	case "", "xts_aes128", "xts_aes256", "aes128", "aes256":
	default:
		return BitLockerWriteRequest{}, ErrInvalidPayload
	}
	pass := body.Password
	rp := strings.TrimSpace(body.RecoveryPassword)
	if utf8.RuneCountInString(pass) > 256 || strings.Contains(pass, "\x00") {
		return BitLockerWriteRequest{}, ErrInvalidPayload
	}
	if utf8.RuneCountInString(rp) > 256 || strings.ContainsAny(rp, "\r\n\x00") {
		return BitLockerWriteRequest{}, ErrInvalidPayload
	}
	pid := strings.TrimSpace(body.ProtectorID)
	if utf8.RuneCountInString(pid) > 128 || strings.ContainsAny(pid, "\r\n\x00") {
		return BitLockerWriteRequest{}, ErrInvalidPayload
	}
	if action == "unlock" && pass == "" && rp == "" {
		return BitLockerWriteRequest{}, ErrInvalidPayload
	}
	if action == "add_protector" && ptype == "" {
		return BitLockerWriteRequest{}, ErrInvalidPayload
	}
	if action == "add_protector" && ptype == "password" && pass == "" {
		return BitLockerWriteRequest{}, ErrInvalidPayload
	}
	if action == "remove_protector" && pid == "" {
		return BitLockerWriteRequest{}, ErrInvalidPayload
	}
	req := BitLockerWriteRequest{
		Action:           action,
		MountPoint:       mount,
		Password:         pass,
		RecoveryPassword: rp,
		ProtectorType:    ptype,
		ProtectorID:      pid,
		EncryptionMethod: method,
	}
	if body.UsedSpaceOnly != nil {
		req.UsedSpaceOnly = *body.UsedSpaceOnly
		req.UsedSpaceOnlySet = true
	} else {
		req.UsedSpaceOnly = true
	}
	return req, nil
}

func normalizeMountPoint(v string) (string, error) {
	s := strings.TrimSpace(v)
	if s == "" || utf8.RuneCountInString(s) > 128 || strings.ContainsAny(s, "\r\n\x00") {
		return "", ErrInvalidPayload
	}
	if len(s) >= 2 && s[1] == ':' {
		letter := strings.ToUpper(s[:1])
		if letter[0] < 'A' || letter[0] > 'Z' {
			return "", ErrInvalidPayload
		}
		return letter + ":", nil
	}
	if strings.HasPrefix(strings.ToUpper(s), `\\?\VOLUME{`) || strings.HasPrefix(strings.ToLower(s), "volume{") {
		return s, nil
	}
	return "", ErrInvalidPayload
}

func optionalEnum(v string, allowed ...string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(v))
	if s == "" {
		return "", nil
	}
	for _, a := range allowed {
		if s == a {
			return s, nil
		}
	}
	return "", ErrInvalidPayload
}

func ValidateTaskPath(path string) (string, error) {
	n := strings.TrimSpace(strings.ReplaceAll(path, "/", `\`))
	if n == "" {
		return "", ErrInvalidPayload
	}
	if !strings.HasPrefix(n, `\`) {
		n = `\` + n
	}
	if utf8.RuneCountInString(n) > maxTaskPath || strings.ContainsAny(n, "\r\n\x00") || strings.Contains(n, "..") {
		return "", ErrInvalidPayload
	}
	lower := strings.ToLower(n)
	if strings.HasSuffix(lower, ".msc") {
		return "", ErrInvalidPayload
	}
	return n, nil
}

func optionalQuery(v string, max int) (string, error) {
	s := strings.TrimSpace(v)
	if s == "" {
		return "", nil
	}
	if utf8.RuneCountInString(s) > max || strings.ContainsAny(s, "\r\n\x00") {
		return "", ErrInvalidPayload
	}
	return s, nil
}

func capabilityKind(name string) string {
	lower := strings.ToLower(name)
	if strings.Contains(lower, "rsat") {
		return "rsat"
	}
	if strings.HasPrefix(lower, "media.mediafeaturepack") {
		return "media"
	}
	return "optional"
}

func normalizeLog(v string) (string, error) {
	s := strings.TrimSpace(v)
	if s == "" {
		return "System", nil
	}
	if utf8.RuneCountInString(s) > maxLogName || strings.ContainsAny(s, "\r\n\x00\\:") || strings.Contains(s, "..") {
		return "", ErrInvalidPayload
	}
	lower := strings.ToLower(s)
	if strings.HasSuffix(lower, ".msc") || strings.HasSuffix(lower, ".evtx") {
		return "", ErrInvalidPayload
	}
	return s, nil
}

func normalizeLevel(v string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "all":
		return "all", nil
	case "critical":
		return "critical", nil
	case "error":
		return "error", nil
	case "warning":
		return "warning", nil
	case "information", "info":
		return "information", nil
	case "verbose":
		return "verbose", nil
	default:
		return "", ErrInvalidPayload
	}
}

func normalizeApp(v string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "quickassist", "quick-assist", "ms-quick-assist":
		return "quickassist", nil
	case "msra", "remoteassist", "remote-assistance":
		return "msra", nil
	default:
		return "", ErrInvalidPayload
	}
}

func normalizeSource(v string) (string, error) {
	s := strings.TrimSpace(v)
	if s == "" {
		return "", nil
	}
	if utf8.RuneCountInString(s) > 128 || strings.ContainsAny(s, "'\"\r\n\x00\\") {
		return "", ErrInvalidPayload
	}
	return s, nil
}

func normalizeTime(v string) (string, error) {
	s := strings.TrimSpace(v)
	if s == "" {
		return "", nil
	}
	parsed, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return "", ErrInvalidPayload
	}
	return parsed.UTC().Format(time.RFC3339), nil
}

func levelPredicate(level string) string {
	switch level {
	case "critical":
		return "(Level=1)"
	case "error":
		return "(Level=1 or Level=2)"
	case "warning":
		return "(Level=1 or Level=2 or Level=3)"
	case "information":
		return "(Level=4 or Level=0)"
	case "verbose":
		return "(Level=5)"
	default:
		return ""
	}
}

func xpathQuery(req EventLogRequest) string {
	var parts []string
	if pred := levelPredicate(req.Level); pred != "" {
		parts = append(parts, pred)
	}
	if req.EventID > 0 {
		parts = append(parts, fmt.Sprintf("(EventID=%d)", req.EventID))
	}
	if req.Source != "" {
		parts = append(parts, fmt.Sprintf("(Provider[@Name='%s'])", req.Source))
	}
	var times []string
	if req.Since != "" {
		times = append(times, fmt.Sprintf("@SystemTime>='%s'", req.Since))
	}
	if req.Until != "" {
		times = append(times, fmt.Sprintf("@SystemTime<='%s'", req.Until))
	}
	if len(times) > 0 {
		parts = append(parts, "(TimeCreated["+strings.Join(times, " and ")+"])")
	}
	if len(parts) == 0 {
		return "*"
	}
	return "*[System[" + strings.Join(parts, " and ") + "]]"
}

func xpathForLevel(level string) string {
	return xpathQuery(EventLogRequest{Level: level})
}

func clipMessage(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\x00", ""))
	if utf8.RuneCountInString(s) <= maxMessage {
		return s
	}
	runes := []rune(s)
	return string(runes[:maxMessage])
}
