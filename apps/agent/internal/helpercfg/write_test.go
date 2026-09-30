package helpercfg

import (
	"os"
	"strings"
	"testing"
)

func TestWriteOmitsSecrets(t *testing.T) {
	dir := t.TempDir()
	path, err := Write(dir, Options{
		AgentServiceName: "PCManagerAgent",
		StatusPort:       17890,
		BackoffSec:       30,
		ProbeIntervalSec: 45,
		FailThreshold:    3,
		MaxBackoffSec:    300,
		StartupGraceSec:  60,
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if strings.Contains(text, "secret") || strings.Contains(text, "enrollment") {
		t.Fatal(text)
	}
	if !strings.Contains(text, "probe_interval_sec: 45") {
		t.Fatal(text)
	}
}
