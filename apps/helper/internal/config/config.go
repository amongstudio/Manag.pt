package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config is local-only. It must not include enrollment secrets or device keys.
type Config struct {
	AgentServiceName    string `yaml:"agent_service_name"`
	StatusPort          int    `yaml:"status_port"`
	BackoffSec          int    `yaml:"backoff_sec"`
	ProbeIntervalSec    int    `yaml:"probe_interval_sec"`
	FailThreshold       int    `yaml:"fail_threshold"`
	MaxBackoffSec       int    `yaml:"max_backoff_sec"`
	StartupGraceSec     int    `yaml:"startup_grace_sec"`
	AgentExe            string `yaml:"agent_exe"`
	UpdateFile          string `yaml:"update_file"`
	UpdateSHA256        string `yaml:"update_sha256"`
	UpdateSignature     string `yaml:"update_signature"`
	UpdateSigningSecret string `yaml:"update_signing_secret"`
	DataDir             string `yaml:"data_dir"`
	configPath          string
}

func DefaultAgentServiceName() string {
	if runtime.GOOS == "windows" {
		return "PCManagerAgent"
	}
	return "pc-manager-agent"
}

func defaultAgentExeName() string {
	if runtime.GOOS == "windows" {
		return "pc-manager-agent.exe"
	}
	return "pc-manager-agent"
}

func Default() Config {
	return Config{
		AgentServiceName: DefaultAgentServiceName(),
		StatusPort:       17890,
		BackoffSec:       30,
		ProbeIntervalSec: 45,
		FailThreshold:    3,
		MaxBackoffSec:    300,
		StartupGraceSec:  60,
	}
}

func Load() (Config, error) {
	cfg := Default()
	candidates := []string{
		os.Getenv("PC_MANAGER_HELPER_CONFIG"),
		"helper.yaml",
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates, filepath.Join(dir, "helper.yaml"))
		if cfg.DataDir == "" {
			cfg.DataDir = dir
		}
		if cfg.AgentExe == "" {
			cfg.AgentExe = filepath.Join(dir, defaultAgentExeName())
		}
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		candidates = append(candidates, filepath.Join(home, ".pc-manager", "helper.yaml"))
	}

	var used string
	for _, c := range candidates {
		if c == "" {
			continue
		}
		raw, err := os.ReadFile(c)
		if err != nil {
			continue
		}
		if err := yaml.Unmarshal(raw, &cfg); err != nil {
			return cfg, err
		}
		used = c
		break
	}
	if used != "" {
		abs, _ := filepath.Abs(used)
		cfg.configPath = abs
	}

	if v := os.Getenv("AGENT_SERVICE_NAME"); v != "" {
		cfg.AgentServiceName = v
	}
	if v := os.Getenv("STATUS_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.StatusPort = n
		}
	}
	if v := os.Getenv("HELPER_BACKOFF_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.BackoffSec = n
		}
	}
	if v := os.Getenv("HELPER_PROBE_INTERVAL_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.ProbeIntervalSec = n
		}
	}
	if v := os.Getenv("HELPER_FAIL_THRESHOLD"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.FailThreshold = n
		}
	}
	if v := os.Getenv("HELPER_MAX_BACKOFF_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.MaxBackoffSec = n
		}
	}
	if v := os.Getenv("HELPER_STARTUP_GRACE_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.StartupGraceSec = n
		}
	}
	if v := os.Getenv("AGENT_EXE"); v != "" {
		cfg.AgentExe = v
	}
	if v := os.Getenv("UPDATE_SIGNING_SECRET"); v != "" {
		cfg.UpdateSigningSecret = v
	}
	if v := os.Getenv("UPDATE_SIGNATURE"); v != "" {
		cfg.UpdateSignature = v
	}

	cfg.applyDefaults()
	if cfg.DataDir != "" {
		if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
			return cfg, err
		}
	}
	return cfg, nil
}

func (c *Config) applyDefaults() {
	if strings.TrimSpace(c.AgentServiceName) == "" {
		c.AgentServiceName = DefaultAgentServiceName()
	}
	if c.StatusPort <= 0 {
		c.StatusPort = 17890
	}
	if c.BackoffSec <= 0 {
		c.BackoffSec = 30
	}
	if c.ProbeIntervalSec <= 0 {
		c.ProbeIntervalSec = 45
	}
	if c.FailThreshold <= 0 {
		c.FailThreshold = 3
	}
	if c.MaxBackoffSec <= 0 {
		c.MaxBackoffSec = 300
	}
	if c.StartupGraceSec < 0 {
		c.StartupGraceSec = 0
	}
	if strings.TrimSpace(c.AgentExe) == "" {
		if exe, err := os.Executable(); err == nil {
			c.AgentExe = filepath.Join(filepath.Dir(exe), defaultAgentExeName())
		} else if runtime.GOOS == "windows" {
			c.AgentExe = filepath.Join(os.Getenv("ProgramFiles"), "PC Manager Agent", defaultAgentExeName())
		} else {
			c.AgentExe = "/opt/pc-manager-agent/" + defaultAgentExeName()
		}
	}
	if strings.TrimSpace(c.DataDir) == "" {
		if exe, err := os.Executable(); err == nil {
			c.DataDir = filepath.Dir(exe)
		}
	}
}

func (c Config) Path() string { return c.configPath }

func (c Config) StatusURL() string {
	return "http://127.0.0.1:" + strconv.Itoa(c.StatusPort) + "/status"
}
