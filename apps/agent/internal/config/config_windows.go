//go:build windows

package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"gopkg.in/yaml.v3"
)

var (
	machineKeyPath = `SOFTWARE\PC Manager\Agent`
	userKeyPath    = `SOFTWARE\PC Manager\Agent`
)

func registryDisplayPath(root string) string {
	switch strings.ToUpper(root) {
	case "HKCU":
		return `HKCU\` + userKeyPath
	default:
		return `HKLM\` + machineKeyPath
	}
}

func loadFromStore(cfg *Config) bool {
	overlay, root, ok := readPreferredHive()
	if !ok {
		return false
	}
	applyRegistry(cfg, overlay)
	cfg.store = storeRegistry
	cfg.registryRoot = root
	cfg.configPath = registryDisplayPath(root)
	return true
}

func persistInitialStore(cfg *Config) {
	cfg.store = storeRegistry
	if err := saveToStore(cfg); err != nil {
		if cfg.registryRoot == "" {
			cfg.registryRoot = "HKCU"
		}
		cfg.configPath = registryDisplayPath(cfg.registryRoot)
		return
	}
	cfg.configPath = registryDisplayPath(cfg.registryRoot)
}

func saveToStore(cfg *Config) error {
	vals := registryValuesFrom(cfg)
	if err := writeHive(registry.LOCAL_MACHINE, machineKeyPath, vals); err == nil {
		cfg.registryRoot = "HKLM"
		cfg.configPath = registryDisplayPath("HKLM")
		return nil
	} else if cfg.registryRoot == "HKLM" {
		// Keep trying HKCU so enroll can persist without admin.
	}
	if err := writeHive(registry.CURRENT_USER, userKeyPath, vals); err != nil {
		return err
	}
	cfg.registryRoot = "HKCU"
	cfg.configPath = registryDisplayPath("HKCU")
	return nil
}

// MigrateUserToMachine copies HKCU agent settings into HKLM. Existing HKLM
// values win when both are set. Called after elevation during self-install.
func MigrateUserToMachine() error {
	user, uok := readHive(registry.CURRENT_USER, userKeyPath)
	if !uok {
		restrictMachineRegistryACL()
		return nil
	}
	machine, mok := readHive(registry.LOCAL_MACHINE, machineKeyPath)
	merged := user
	if mok {
		merged = mergeRegistry(machine, user)
	}
	if err := writeHive(registry.LOCAL_MACHINE, machineKeyPath, merged); err != nil {
		return err
	}
	restrictMachineRegistryACL()
	return nil
}

func fillIdentityFromStore(m map[string]any) {
	if m == nil {
		return
	}
	overlay, _, ok := readPreferredHive()
	if !ok {
		return
	}
	if yamlValueEmpty(m["device_id"]) && overlay.DeviceID != "" {
		m["device_id"] = overlay.DeviceID
	}
	if yamlValueEmpty(m["device_key"]) && overlay.DeviceKey != "" {
		m["device_key"] = overlay.DeviceKey
	}
}

func overlayFromYAML(raw []byte) (registryValues, bool) {
	raw = stripBOM(raw)
	var o fileOverlay
	if err := yaml.Unmarshal(raw, &o); err != nil {
		return registryValues{}, false
	}
	cfg := Default()
	applyOverlay(&cfg, o, raw)
	vals := registryValuesFrom(&cfg)
	vals.present = map[string]bool{}
	var present map[string]any
	_ = yaml.Unmarshal(raw, &present)
	for k := range present {
		vals.present[k] = true
	}
	return vals, len(vals.present) > 0
}

// ImportYAMLToMachine gap-fills HKLM from a YAML file. Existing HKLM values win.
func ImportYAMLToMachine(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	fromFile, ok := overlayFromYAML(raw)
	if !ok {
		return nil
	}
	machine, mok := readHive(registry.LOCAL_MACHINE, machineKeyPath)
	merged := fromFile
	if mok {
		merged = mergeRegistry(machine, fromFile)
	}
	if err := writeHive(registry.LOCAL_MACHINE, machineKeyPath, merged); err != nil {
		return err
	}
	restrictMachineRegistryACL()
	return nil
}

// PersistForService writes sidecar YAML into HKLM (and keeps HKCU→HKLM migrate)
// so the LocalSystem service enrolls with the pack secret, not baked defaults.
func PersistForService(yamlPaths ...string) error {
	var last error
	for _, p := range yamlPaths {
		if err := ImportYAMLToMachine(p); err != nil {
			last = err
		}
	}
	if err := MigrateUserToMachine(); err != nil {
		return err
	}
	return last
}

func readPreferredHive() (registryValues, string, bool) {
	if v, ok := readHive(registry.LOCAL_MACHINE, machineKeyPath); ok {
		return v, "HKLM", true
	}
	if v, ok := readHive(registry.CURRENT_USER, userKeyPath); ok {
		return v, "HKCU", true
	}
	return registryValues{}, "", false
}

type registryValues struct {
	present               map[string]bool
	ServerURL             string
	FallbackURLs          []string
	EnrollmentSecret      string
	DeviceID              string
	DeviceKey             string
	HeartbeatIntervalSec  int
	IdleHeartbeatSec      int
	WatchedHeartbeatSec   int
	PollIntervalSec       int
	ScreenshotIntervalSec int
	AutoRestartTime       string
	DataDir               string
	SandboxRoots          []string
	StatusPort            int
	Lightweight           bool
	EnableGPU             bool
	EnableTemps           bool
	EnablePlugins         bool
	EnableScreenshot      bool
	EnableWebrtc          bool
}

func readHive(root registry.Key, path string) (registryValues, bool) {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
	if err != nil {
		return registryValues{}, false
	}
	defer k.Close()
	out := registryValues{present: map[string]bool{}}
	found := false
	if s, _, err := k.GetStringValue("server_url"); err == nil {
		out.ServerURL = s
		out.present["server_url"] = true
		found = true
	}
	if ss, _, err := k.GetStringsValue("fallback_urls"); err == nil {
		out.FallbackURLs = ss
		out.present["fallback_urls"] = true
		found = true
	} else if s, _, err := k.GetStringValue("fallback_urls"); err == nil {
		out.FallbackURLs = splitComma(s)
		out.present["fallback_urls"] = true
		found = true
	}
	if s, _, err := k.GetStringValue("enrollment_secret"); err == nil {
		out.EnrollmentSecret = s
		out.present["enrollment_secret"] = true
		found = true
	}
	if s, _, err := k.GetStringValue("device_id"); err == nil {
		out.DeviceID = s
		out.present["device_id"] = true
		found = true
	}
	if s, _, err := k.GetStringValue("device_key"); err == nil {
		out.DeviceKey = s
		out.present["device_key"] = true
		found = true
	}
	readInt(k, "heartbeat_interval_sec", &out.HeartbeatIntervalSec, out.present, &found)
	readInt(k, "idle_heartbeat_sec", &out.IdleHeartbeatSec, out.present, &found)
	readInt(k, "watched_heartbeat_sec", &out.WatchedHeartbeatSec, out.present, &found)
	readInt(k, "poll_interval_sec", &out.PollIntervalSec, out.present, &found)
	readInt(k, "screenshot_interval_sec", &out.ScreenshotIntervalSec, out.present, &found)
	if s, _, err := k.GetStringValue("auto_restart_time"); err == nil {
		out.AutoRestartTime = s
		out.present["auto_restart_time"] = true
		found = true
	}
	if s, _, err := k.GetStringValue("data_dir"); err == nil {
		out.DataDir = s
		out.present["data_dir"] = true
		found = true
	}
	if ss, _, err := k.GetStringsValue("sandbox_roots"); err == nil {
		out.SandboxRoots = ss
		out.present["sandbox_roots"] = true
		found = true
	} else if s, _, err := k.GetStringValue("sandbox_roots"); err == nil {
		out.SandboxRoots = splitComma(s)
		out.present["sandbox_roots"] = true
		found = true
	}
	readInt(k, "status_port", &out.StatusPort, out.present, &found)
	readBool(k, "lightweight", &out.Lightweight, out.present, &found)
	readBool(k, "enable_gpu", &out.EnableGPU, out.present, &found)
	readBool(k, "enable_temps", &out.EnableTemps, out.present, &found)
	readBool(k, "enable_plugins", &out.EnablePlugins, out.present, &found)
	readBool(k, "enable_screenshot", &out.EnableScreenshot, out.present, &found)
	readBool(k, "enable_webrtc", &out.EnableWebrtc, out.present, &found)
	return out, found
}

func readInt(k registry.Key, name string, dest *int, present map[string]bool, found *bool) {
	n, _, err := k.GetIntegerValue(name)
	if err != nil {
		if s, _, err := k.GetStringValue(name); err == nil {
			v, conv := strconv.Atoi(strings.TrimSpace(s))
			if conv != nil {
				return
			}
			n = uint64(v)
		} else {
			return
		}
	}
	*dest = int(n)
	present[name] = true
	*found = true
}

func readBool(k registry.Key, name string, dest *bool, present map[string]bool, found *bool) {
	n, _, err := k.GetIntegerValue(name)
	if err != nil {
		if s, _, err := k.GetStringValue(name); err == nil {
			*dest = parseBool(s)
			present[name] = true
			*found = true
		}
		return
	}
	*dest = n != 0
	present[name] = true
	*found = true
}

func applyRegistry(cfg *Config, o registryValues) {
	if o.present["server_url"] && strings.TrimSpace(o.ServerURL) != "" {
		cfg.ServerURL = strings.TrimSpace(o.ServerURL)
	}
	if o.present["fallback_urls"] {
		cfg.FallbackURLs = append([]string(nil), o.FallbackURLs...)
	}
	if o.present["enrollment_secret"] {
		cfg.EnrollmentSecret = o.EnrollmentSecret
	}
	if o.present["device_id"] {
		cfg.DeviceID = o.DeviceID
	}
	if o.present["device_key"] {
		cfg.DeviceKey = o.DeviceKey
	}
	if o.present["heartbeat_interval_sec"] {
		cfg.HeartbeatIntervalSec = o.HeartbeatIntervalSec
	}
	if o.present["idle_heartbeat_sec"] {
		cfg.IdleHeartbeatSec = o.IdleHeartbeatSec
	}
	if o.present["watched_heartbeat_sec"] {
		cfg.WatchedHeartbeatSec = o.WatchedHeartbeatSec
	}
	if o.present["poll_interval_sec"] {
		cfg.PollIntervalSec = o.PollIntervalSec
	}
	if o.present["screenshot_interval_sec"] {
		cfg.ScreenshotIntervalSec = o.ScreenshotIntervalSec
	}
	if o.present["auto_restart_time"] {
		cfg.AutoRestartTime = o.AutoRestartTime
	}
	if o.present["data_dir"] && strings.TrimSpace(o.DataDir) != "" {
		cfg.DataDir = strings.TrimSpace(o.DataDir)
	}
	if o.present["sandbox_roots"] {
		cfg.SandboxRoots = append([]string(nil), o.SandboxRoots...)
	}
	if o.present["status_port"] {
		cfg.StatusPort = o.StatusPort
	}
	if o.present["lightweight"] {
		cfg.Lightweight = o.Lightweight
	}
	if o.present["enable_gpu"] {
		cfg.EnableGPU = o.EnableGPU
	}
	if o.present["enable_temps"] {
		cfg.EnableTemps = o.EnableTemps
	}
	if o.present["enable_plugins"] {
		cfg.EnablePlugins = o.EnablePlugins
	}
	if o.present["enable_screenshot"] {
		cfg.EnableScreenshot = o.EnableScreenshot
	}
	if o.present["enable_webrtc"] {
		cfg.EnableWebrtc = o.EnableWebrtc
	}
}

func registryValuesFrom(cfg *Config) registryValues {
	return registryValues{
		present:               map[string]bool{},
		ServerURL:             cfg.ServerURL,
		FallbackURLs:          append([]string(nil), cfg.FallbackURLs...),
		EnrollmentSecret:      cfg.EnrollmentSecret,
		DeviceID:              cfg.DeviceID,
		DeviceKey:             cfg.DeviceKey,
		HeartbeatIntervalSec:  cfg.HeartbeatIntervalSec,
		IdleHeartbeatSec:      cfg.IdleHeartbeatSec,
		WatchedHeartbeatSec:   cfg.WatchedHeartbeatSec,
		PollIntervalSec:       cfg.PollIntervalSec,
		ScreenshotIntervalSec: cfg.ScreenshotIntervalSec,
		AutoRestartTime:       cfg.AutoRestartTime,
		DataDir:               cfg.DataDir,
		SandboxRoots:          append([]string(nil), cfg.SandboxRoots...),
		StatusPort:            cfg.StatusPort,
		Lightweight:           cfg.Lightweight,
		EnableGPU:             cfg.EnableGPU,
		EnableTemps:           cfg.EnableTemps,
		EnablePlugins:         cfg.EnablePlugins,
		EnableScreenshot:      cfg.EnableScreenshot,
		EnableWebrtc:          cfg.EnableWebrtc,
	}
}

func mergeRegistry(machine, user registryValues) registryValues {
	out := machine
	if out.present == nil {
		out.present = map[string]bool{}
	}
	fill := func(name string, empty bool, copy func()) {
		if !out.present[name] || empty {
			if user.present[name] {
				copy()
				out.present[name] = true
			}
		}
	}
	fill("server_url", strings.TrimSpace(out.ServerURL) == "", func() { out.ServerURL = user.ServerURL })
	fill("fallback_urls", len(out.FallbackURLs) == 0, func() { out.FallbackURLs = append([]string(nil), user.FallbackURLs...) })
	fill("enrollment_secret", out.EnrollmentSecret == "", func() { out.EnrollmentSecret = user.EnrollmentSecret })
	fill("device_id", out.DeviceID == "", func() { out.DeviceID = user.DeviceID })
	fill("device_key", out.DeviceKey == "", func() { out.DeviceKey = user.DeviceKey })
	fill("heartbeat_interval_sec", !machine.present["heartbeat_interval_sec"], func() { out.HeartbeatIntervalSec = user.HeartbeatIntervalSec })
	fill("idle_heartbeat_sec", !machine.present["idle_heartbeat_sec"], func() { out.IdleHeartbeatSec = user.IdleHeartbeatSec })
	fill("watched_heartbeat_sec", !machine.present["watched_heartbeat_sec"], func() { out.WatchedHeartbeatSec = user.WatchedHeartbeatSec })
	fill("poll_interval_sec", !machine.present["poll_interval_sec"], func() { out.PollIntervalSec = user.PollIntervalSec })
	fill("screenshot_interval_sec", !machine.present["screenshot_interval_sec"], func() { out.ScreenshotIntervalSec = user.ScreenshotIntervalSec })
	fill("auto_restart_time", out.AutoRestartTime == "", func() { out.AutoRestartTime = user.AutoRestartTime })
	fill("data_dir", strings.TrimSpace(out.DataDir) == "", func() { out.DataDir = user.DataDir })
	fill("sandbox_roots", len(out.SandboxRoots) == 0, func() { out.SandboxRoots = append([]string(nil), user.SandboxRoots...) })
	fill("status_port", !machine.present["status_port"], func() { out.StatusPort = user.StatusPort })
	fill("lightweight", !machine.present["lightweight"], func() { out.Lightweight = user.Lightweight })
	fill("enable_gpu", !machine.present["enable_gpu"], func() { out.EnableGPU = user.EnableGPU })
	fill("enable_temps", !machine.present["enable_temps"], func() { out.EnableTemps = user.EnableTemps })
	fill("enable_plugins", !machine.present["enable_plugins"], func() { out.EnablePlugins = user.EnablePlugins })
	fill("enable_screenshot", !machine.present["enable_screenshot"], func() { out.EnableScreenshot = user.EnableScreenshot })
	fill("enable_webrtc", !machine.present["enable_webrtc"], func() { out.EnableWebrtc = user.EnableWebrtc })
	return out
}

func writeHive(root registry.Key, path string, vals registryValues) error {
	k, err := createKeyPath(root, path, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer k.Close()
	setString := func(name, v string) error {
		return k.SetStringValue(name, v)
	}
	if err := setString("server_url", vals.ServerURL); err != nil {
		return err
	}
	if err := k.SetStringsValue("fallback_urls", vals.FallbackURLs); err != nil {
		return err
	}
	if err := setString("enrollment_secret", vals.EnrollmentSecret); err != nil {
		return err
	}
	if err := setString("device_id", vals.DeviceID); err != nil {
		return err
	}
	if err := setString("device_key", vals.DeviceKey); err != nil {
		return err
	}
	setDword := func(name string, n int) error {
		if n < 0 {
			n = 0
		}
		return k.SetDWordValue(name, uint32(n))
	}
	if err := setDword("heartbeat_interval_sec", vals.HeartbeatIntervalSec); err != nil {
		return err
	}
	if err := setDword("idle_heartbeat_sec", vals.IdleHeartbeatSec); err != nil {
		return err
	}
	if err := setDword("watched_heartbeat_sec", vals.WatchedHeartbeatSec); err != nil {
		return err
	}
	if err := setDword("poll_interval_sec", vals.PollIntervalSec); err != nil {
		return err
	}
	if err := setDword("screenshot_interval_sec", vals.ScreenshotIntervalSec); err != nil {
		return err
	}
	if err := setString("auto_restart_time", vals.AutoRestartTime); err != nil {
		return err
	}
	if err := setString("data_dir", vals.DataDir); err != nil {
		return err
	}
	if err := k.SetStringsValue("sandbox_roots", vals.SandboxRoots); err != nil {
		return err
	}
	if err := setDword("status_port", vals.StatusPort); err != nil {
		return err
	}
	setBool := func(name string, v bool) error {
		n := uint32(0)
		if v {
			n = 1
		}
		return k.SetDWordValue(name, n)
	}
	if err := setBool("lightweight", vals.Lightweight); err != nil {
		return err
	}
	if err := setBool("enable_gpu", vals.EnableGPU); err != nil {
		return err
	}
	if err := setBool("enable_temps", vals.EnableTemps); err != nil {
		return err
	}
	if err := setBool("enable_plugins", vals.EnablePlugins); err != nil {
		return err
	}
	if err := setBool("enable_screenshot", vals.EnableScreenshot); err != nil {
		return err
	}
	if err := setBool("enable_webrtc", vals.EnableWebrtc); err != nil {
		return err
	}
	if root == registry.LOCAL_MACHINE {
		restrictRegistryKey(path)
	}
	return nil
}

func createKeyPath(root registry.Key, path string, access uint32) (registry.Key, error) {
	parts := strings.Split(path, `\`)
	k := root
	closePrev := false
	for i, p := range parts {
		if p == "" {
			continue
		}
		acc := access
		if i < len(parts)-1 {
			acc = registry.CREATE_SUB_KEY | registry.QUERY_VALUE | registry.ENUMERATE_SUB_KEYS
		}
		nk, _, err := registry.CreateKey(k, p, acc)
		if closePrev {
			_ = k.Close()
		}
		if err != nil {
			return 0, fmt.Errorf("registry %s: %w", p, err)
		}
		k = nk
		closePrev = true
	}
	if !closePrev {
		return 0, fmt.Errorf("empty registry path")
	}
	return k, nil
}

func splitComma(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func deleteKeyPath(root registry.Key, path string) {
	_ = registry.DeleteKey(root, path)
}

const (
	sddlFileAdminSystem = "D:P(A;;FA;;;SY)(A;;FA;;;BA)"
	sddlRegAdminSystem  = "D:P(A;;KA;;;SY)(A;;KA;;;BA)"
)

func restrictFileACL(path string) {
	if strings.TrimSpace(path) == "" || !isMachineInstallPath(path) {
		return
	}
	restrictNamed(path, windows.SE_FILE_OBJECT, sddlFileAdminSystem)
}

func isMachineInstallPath(path string) bool {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	abs = strings.ToLower(filepath.Clean(abs))
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "ProgramData"} {
		v := strings.TrimSpace(os.Getenv(env))
		if v == "" {
			continue
		}
		root := strings.ToLower(filepath.Clean(v))
		if abs == root || strings.HasPrefix(abs, root+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

func RestrictFileACL(path string) { restrictFileACL(path) }

func restrictMachineRegistryACL() {
	restrictRegistryKey(machineKeyPath)
}

func restrictRegistryKey(subpath string) {
	if strings.TrimSpace(subpath) == "" {
		return
	}
	restrictNamed(`MACHINE\`+subpath, windows.SE_REGISTRY_KEY, sddlRegAdminSystem)
}

func restrictNamed(name string, kind windows.SE_OBJECT_TYPE, sddl string) {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		return
	}
	_ = windows.SetNamedSecurityInfo(
		name,
		kind,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil,
	)
}
