package helpercfg

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Options struct {
	AgentServiceName string
	StatusPort       int
	BackoffSec       int
	ProbeIntervalSec int
	FailThreshold    int
	MaxBackoffSec    int
	StartupGraceSec  int
}

func YAML(opt Options) string {
	return strings.Join([]string{
		"agent_service_name: " + opt.AgentServiceName,
		fmt.Sprintf("status_port: %d", opt.StatusPort),
		fmt.Sprintf("backoff_sec: %d", opt.BackoffSec),
		fmt.Sprintf("probe_interval_sec: %d", opt.ProbeIntervalSec),
		fmt.Sprintf("fail_threshold: %d", opt.FailThreshold),
		fmt.Sprintf("max_backoff_sec: %d", opt.MaxBackoffSec),
		fmt.Sprintf("startup_grace_sec: %d", opt.StartupGraceSec),
		"",
	}, "\n")
}

func Write(dir string, opt Options) (string, error) {
	if dir == "" {
		return "", fmt.Errorf("helper_config_path")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "helper.yaml")
	return path, os.WriteFile(path, []byte(YAML(opt)), 0o644)
}
