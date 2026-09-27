package config

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

func stripBOM(raw []byte) []byte {
	return bytes.TrimPrefix(raw, utf8BOM)
}

func SidecarYAMLPath(agentExe string) string {
	agentExe = strings.TrimSpace(agentExe)
	if agentExe == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(agentExe), "config.yaml")
}

type Config struct {
	mu                    sync.RWMutex
	ServerURL             string   `yaml:"server_url"`
	FallbackURLs          []string `yaml:"fallback_urls"`
	EnrollmentSecret      string   `yaml:"enrollment_secret"`
	DeviceID              string   `yaml:"device_id"`
	DeviceKey             string   `yaml:"device_key"`
	HeartbeatIntervalSec  int      `yaml:"heartbeat_interval_sec"`
	IdleHeartbeatSec      int      `yaml:"idle_heartbeat_sec"`
	WatchedHeartbeatSec   int      `yaml:"watched_heartbeat_sec"`
	PollIntervalSec       int      `yaml:"poll_interval_sec"`
	ScreenshotIntervalSec int      `yaml:"screenshot_interval_sec"`
	AutoRestartTime       string   `yaml:"auto_restart_time"`
	DataDir               string   `yaml:"data_dir"`
	SandboxRoots          []string `yaml:"sandbox_roots"`
	StatusPort            int      `yaml:"status_port"`
	Lightweight           bool     `yaml:"lightweight"`
	EnableGPU             bool     `yaml:"enable_gpu"`
	EnableTemps           bool     `yaml:"enable_temps"`
	EnablePlugins         bool     `yaml:"enable_plugins"`
	EnableScreenshot      bool     `yaml:"enable_screenshot"`
	EnableWebrtc          bool     `yaml:"enable_webrtc"`
	configPath            string
	tried                 []string
	store                 storeKind
	registryRoot          string
}

type storeKind int

const (
	storeFile storeKind = iota
	storeRegistry
)

// DefaultServerURL is the compile-time fallback when no YAML or registry value
// is present. Override with -ldflags -X github.com/pc-manager/agent/internal/config.DefaultServerURL=...
// Env SERVER_URL still wins at runtime.
var DefaultServerURL = "http://localhost:4000"

const (
	MachineRegistryPath = `HKLM\SOFTWARE\PC Manager\Agent`
	UserRegistryPath    = `HKCU\SOFTWARE\PC Manager\Agent`
)

func bakedServerURL() string {
	u := strings.TrimSpace(DefaultServerURL)
	if u == "" {
		return "http://localhost:4000"
	}
	return u
}

// fileOverlay uses pointers so omitted YAML keys keep Default() values and
// empty strings (notably data_dir: "") do not clobber defaults.
type fileOverlay struct {
	ServerURL             *string  `yaml:"server_url"`
	FallbackURLs          []string `yaml:"fallback_urls"`
	EnrollmentSecret      *string  `yaml:"enrollment_secret"`
	DeviceID              *string  `yaml:"device_id"`
	DeviceKey             *string  `yaml:"device_key"`
	HeartbeatIntervalSec  *int     `yaml:"heartbeat_interval_sec"`
	IdleHeartbeatSec      *int     `yaml:"idle_heartbeat_sec"`
	WatchedHeartbeatSec   *int     `yaml:"watched_heartbeat_sec"`
	PollIntervalSec       *int     `yaml:"poll_interval_sec"`
	ScreenshotIntervalSec *int     `yaml:"screenshot_interval_sec"`
	AutoRestartTime       *string  `yaml:"auto_restart_time"`
	DataDir               *string  `yaml:"data_dir"`
	SandboxRoots          []string `yaml:"sandbox_roots"`
	StatusPort            *int     `yaml:"status_port"`
	Lightweight           *bool    `yaml:"lightweight"`
	EnableGPU             *bool    `yaml:"enable_gpu"`
	EnableTemps           *bool    `yaml:"enable_temps"`
	EnablePlugins         *bool    `yaml:"enable_plugins"`
	EnableScreenshot      *bool    `yaml:"enable_screenshot"`
	EnableWebrtc          *bool    `yaml:"enable_webrtc"`
}

type fileShape struct {
	ServerURL             string   `yaml:"server_url"`
	FallbackURLs          []string `yaml:"fallback_urls"`
	EnrollmentSecret      string   `yaml:"enrollment_secret"`
	DeviceID              string   `yaml:"device_id"`
	DeviceKey             string   `yaml:"device_key"`
	HeartbeatIntervalSec  int      `yaml:"heartbeat_interval_sec"`
	IdleHeartbeatSec      int      `yaml:"idle_heartbeat_sec"`
	WatchedHeartbeatSec   int      `yaml:"watched_heartbeat_sec"`
	PollIntervalSec       int      `yaml:"poll_interval_sec"`
	ScreenshotIntervalSec int      `yaml:"screenshot_interval_sec"`
	AutoRestartTime       string   `yaml:"auto_restart_time"`
	DataDir               string   `yaml:"data_dir"`
	SandboxRoots          []string `yaml:"sandbox_roots"`
	StatusPort            int      `yaml:"status_port"`
	Lightweight           bool     `yaml:"lightweight"`
	EnableGPU             bool     `yaml:"enable_gpu"`
	EnableTemps           bool     `yaml:"enable_temps"`
	EnablePlugins         bool     `yaml:"enable_plugins"`
	EnableScreenshot      bool     `yaml:"enable_screenshot"`
	EnableWebrtc          bool     `yaml:"enable_webrtc"`
}

func Default() Config {
	home, _ := os.UserHomeDir()
	return Config{
		ServerURL:            bakedServerURL(),
		HeartbeatIntervalSec: 90,
		IdleHeartbeatSec:     90,
		WatchedHeartbeatSec:  15,
		PollIntervalSec:      15,
		DataDir:              filepath.Join(home, ".pc-manager"),
		StatusPort:           17890,
		Lightweight:          true,
		EnablePlugins:        true,
		EnableScreenshot:     true,
	}
}

func ignoreExeDir(exe string) bool {
	return strings.Contains(strings.ToLower(filepath.ToSlash(exe)), "go-build")
}

func walkUp(start, name string) []string {
	var out []string
	dir, err := filepath.Abs(start)
	if err != nil {
		return nil
	}
	for {
		out = append(out, filepath.Join(dir, name))
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return out
}

func candidatePaths() []string {
	seen := make(map[string]struct{})
	var out []string
	add := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" {
			return
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			abs = p
		}
		if _, ok := seen[abs]; ok {
			return
		}
		seen[abs] = struct{}{}
		out = append(out, abs)
	}

	add(os.Getenv("PC_MANAGER_CONFIG"))
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	for _, p := range walkUp(cwd, "config.yaml") {
		add(p)
	}
	if exe, err := os.Executable(); err == nil && !ignoreExeDir(exe) {
		add(filepath.Join(filepath.Dir(exe), "config.yaml"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Join(home, ".pc-manager", "config.yaml"))
	}
	return out
}

func applyOverlay(cfg *Config, o fileOverlay, raw []byte) {
	var present map[string]any
	_ = yaml.Unmarshal(raw, &present)

	if o.ServerURL != nil && strings.TrimSpace(*o.ServerURL) != "" {
		cfg.ServerURL = strings.TrimSpace(*o.ServerURL)
	}
	if _, ok := present["fallback_urls"]; ok {
		cfg.FallbackURLs = append([]string(nil), o.FallbackURLs...)
	}
	if o.EnrollmentSecret != nil {
		cfg.EnrollmentSecret = *o.EnrollmentSecret
	}
	if o.DeviceID != nil {
		cfg.DeviceID = *o.DeviceID
	}
	if o.DeviceKey != nil {
		cfg.DeviceKey = *o.DeviceKey
	}
	if o.HeartbeatIntervalSec != nil {
		cfg.HeartbeatIntervalSec = *o.HeartbeatIntervalSec
	}
	if o.IdleHeartbeatSec != nil {
		cfg.IdleHeartbeatSec = *o.IdleHeartbeatSec
	}
	if o.WatchedHeartbeatSec != nil {
		cfg.WatchedHeartbeatSec = *o.WatchedHeartbeatSec
	}
	if o.PollIntervalSec != nil {
		cfg.PollIntervalSec = *o.PollIntervalSec
	}
	if o.ScreenshotIntervalSec != nil {
		cfg.ScreenshotIntervalSec = *o.ScreenshotIntervalSec
	}
	if o.AutoRestartTime != nil {
		cfg.AutoRestartTime = *o.AutoRestartTime
	}
	if o.DataDir != nil && strings.TrimSpace(*o.DataDir) != "" {
		cfg.DataDir = strings.TrimSpace(*o.DataDir)
	}
	if _, ok := present["sandbox_roots"]; ok {
		cfg.SandboxRoots = append([]string(nil), o.SandboxRoots...)
	}
	if o.StatusPort != nil {
		cfg.StatusPort = *o.StatusPort
	}
	if o.Lightweight != nil {
		cfg.Lightweight = *o.Lightweight
	}
	if o.EnableGPU != nil {
		cfg.EnableGPU = *o.EnableGPU
	}
	if o.EnableTemps != nil {
		cfg.EnableTemps = *o.EnableTemps
	}
	if o.EnablePlugins != nil {
		cfg.EnablePlugins = *o.EnablePlugins
	}
	if o.EnableScreenshot != nil {
		cfg.EnableScreenshot = *o.EnableScreenshot
	}
	if o.EnableWebrtc != nil {
		cfg.EnableWebrtc = *o.EnableWebrtc
	}
}

func (c *Config) normalizeIntervals() {
	if c.HeartbeatIntervalSec <= 0 {
		c.HeartbeatIntervalSec = 90
	}
	if c.IdleHeartbeatSec <= 0 {
		c.IdleHeartbeatSec = c.HeartbeatIntervalSec
	}
	if c.WatchedHeartbeatSec <= 0 {
		c.WatchedHeartbeatSec = 15
	}
	if c.PollIntervalSec <= 0 {
		c.PollIntervalSec = 15
	}
}

func Load() (*Config, error) {
	cfg := Default()
	candidates := candidatePaths()
	cfg.tried = append([]string(nil), candidates...)

	var used string
	for _, c := range candidates {
		raw, err := os.ReadFile(c)
		if err != nil {
			continue
		}
		raw = stripBOM(raw)
		var overlay fileOverlay
		if err := yaml.Unmarshal(raw, &overlay); err != nil {
			return nil, err
		}
		applyOverlay(&cfg, overlay, raw)
		used = c
		break
	}
	if used != "" {
		abs, _ := filepath.Abs(used)
		cfg.configPath = abs
		cfg.store = storeFile
	} else if loadFromStore(&cfg) {
		cfg.tried = append(cfg.tried, cfg.configPath)
	} else {
		cfg.configPath = filepath.Join(cfg.DataDir, "config.yaml")
		cfg.store = storeFile
		persistInitialStore(&cfg)
	}
	applyEnv(&cfg)
	cfg.normalizeIntervals()
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func applyEnv(cfg *Config) {
	if v := os.Getenv("SERVER_URL"); v != "" {
		cfg.ServerURL = v
	}
	if v := os.Getenv("ENROLLMENT_SECRET"); v != "" {
		cfg.EnrollmentSecret = v
	}
	if v := os.Getenv("FALLBACK_URLS"); v != "" {
		cfg.FallbackURLs = strings.Split(v, ",")
	}
	if v := os.Getenv("HEARTBEAT_INTERVAL_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.HeartbeatIntervalSec = n
		}
	}
	if v := os.Getenv("ENABLE_GPU"); v != "" {
		cfg.EnableGPU = parseBool(v)
	}
	if v := os.Getenv("ENABLE_TEMPS"); v != "" {
		cfg.EnableTemps = parseBool(v)
	}
	if v := os.Getenv("ENABLE_WEBRTC"); v != "" {
		cfg.EnableWebrtc = parseBool(v)
	}
	if v := os.Getenv("LIGHTWEIGHT"); v != "" {
		cfg.Lightweight = parseBool(v)
	}
}

func (c *Config) Path() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.configPath
}

func (c *Config) Tried() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]string(nil), c.tried...)
}

func (c *Config) Enrolled() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.DeviceID != "" && c.DeviceKey != ""
}

func (c *Config) UsingRegistry() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.store == storeRegistry
}

func (c *Config) Lock()    { c.mu.Lock() }
func (c *Config) Unlock()  { c.mu.Unlock() }
func (c *Config) RLock()   { c.mu.RLock() }
func (c *Config) RUnlock() { c.mu.RUnlock() }

func (c *Config) snapshot() fileShape {
	return fileShape{
		ServerURL:             c.ServerURL,
		FallbackURLs:          append([]string(nil), c.FallbackURLs...),
		EnrollmentSecret:      c.EnrollmentSecret,
		DeviceID:              c.DeviceID,
		DeviceKey:             c.DeviceKey,
		HeartbeatIntervalSec:  c.HeartbeatIntervalSec,
		IdleHeartbeatSec:      c.IdleHeartbeatSec,
		WatchedHeartbeatSec:   c.WatchedHeartbeatSec,
		PollIntervalSec:       c.PollIntervalSec,
		ScreenshotIntervalSec: c.ScreenshotIntervalSec,
		AutoRestartTime:       c.AutoRestartTime,
		DataDir:               c.DataDir,
		SandboxRoots:          append([]string(nil), c.SandboxRoots...),
		StatusPort:            c.StatusPort,
		Lightweight:           c.Lightweight,
		EnableGPU:             c.EnableGPU,
		EnableTemps:           c.EnableTemps,
		EnablePlugins:         c.EnablePlugins,
		EnableScreenshot:      c.EnableScreenshot,
		EnableWebrtc:          c.EnableWebrtc,
	}
}

func (c *Config) Save() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.store == storeRegistry {
		return saveToStore(c)
	}
	dir := filepath.Dir(c.configPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, err := yaml.Marshal(c.snapshot())
	if err != nil {
		return err
	}
	tmp := c.configPath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, c.configPath); err != nil {
		_ = os.Remove(c.configPath)
		if err2 := os.Rename(tmp, c.configPath); err2 != nil {
			_ = os.Remove(tmp)
			return err2
		}
	}
	restrictFileACL(c.configPath)
	return nil
}

func yamlValueEmpty(v any) bool {
	if v == nil {
		return true
	}
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t) == ""
	case []any:
		return len(t) == 0
	case []string:
		return len(t) == 0
	default:
		return false
	}
}

// MergeSidecarYAML copies sidecar YAML into dest. Existing dest keys win when
// set; empty dest enrollment_secret / server_url are filled from the sidecar
// so a stamp pack can enroll the service without wiping an existing identity.
func MergeSidecarYAML(sidecar, dest string) error {
	sidecar = strings.TrimSpace(sidecar)
	dest = strings.TrimSpace(dest)
	if sidecar == "" || dest == "" {
		return nil
	}
	srcRaw, err := os.ReadFile(sidecar)
	if err != nil {
		return err
	}
	srcRaw = stripBOM(srcRaw)
	var src map[string]any
	if err := yaml.Unmarshal(srcRaw, &src); err != nil {
		return err
	}
	if src == nil {
		src = map[string]any{}
	}
	out := src
	if destRaw, err := os.ReadFile(dest); err == nil {
		var destMap map[string]any
		if err := yaml.Unmarshal(stripBOM(destRaw), &destMap); err != nil {
			return err
		}
		if destMap == nil {
			destMap = map[string]any{}
		}
		for k, v := range src {
			if yamlValueEmpty(destMap[k]) && !yamlValueEmpty(v) {
				destMap[k] = v
			}
		}
		out = destMap
	}
	fillIdentityFromStore(out)
	raw, err := yaml.Marshal(out)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp := dest + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	restrictFileACL(dest)
	return nil
}

func (c *Config) Endpoints() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := []string{strings.TrimRight(c.ServerURL, "/")}
	for _, u := range c.FallbackURLs {
		u = strings.TrimSpace(strings.TrimRight(u, "/"))
		if u != "" {
			out = append(out, u)
		}
	}
	return out
}

func parseBool(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
