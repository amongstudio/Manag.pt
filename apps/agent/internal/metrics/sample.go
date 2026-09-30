package metrics

import (
	"context"
	"encoding/json"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/pc-manager/agent/internal/monitor"
	"github.com/pc-manager/agent/internal/svcctl"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
)

type Sample struct {
	Name   string            `json:"name"`
	Value  float64           `json:"value"`
	Labels map[string]string `json:"labels,omitempty"`
}

func SampleHost(services []string, started time.Time) map[string]any {
	samples := make([]Sample, 0, 16)
	snap := monitor.Collect(monitor.Options{Mode: monitor.ModeIdle})
	samples = append(samples, Sample{Name: "cpu_pct", Value: snap.CPU}, Sample{Name: "ram_pct", Value: snap.RAM})
	if parts, err := disk.Partitions(false); err == nil {
		for _, part := range parts {
			if len(samples) >= 24 {
				break
			}
			usage, err := disk.Usage(part.Mountpoint)
			if err != nil || usage.Total == 0 {
				continue
			}
			free := 100 - usage.UsedPercent
			samples = append(samples, Sample{Name: "disk_free_pct", Value: free, Labels: map[string]string{"mount": part.Mountpoint}})
		}
	}
	if !started.IsZero() {
		samples = append(samples, Sample{Name: "agent_uptime_sec", Value: time.Since(started).Seconds()})
	}
	if info, err := host.Info(); err == nil {
		samples = append(samples, Sample{Name: "boot_time_unix", Value: float64(info.BootTime)})
	}
	if users, err := host.Users(); err == nil {
		samples = append(samples, Sample{Name: "session_count", Value: float64(len(users))})
	}
	for _, name := range services {
		if len(samples) >= 40 {
			break
		}
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		up := serviceUp(name)
		if up < 0 {
			continue
		}
		samples = append(samples, Sample{Name: "service_up", Value: up, Labels: map[string]string{"name": name}})
	}
	body := map[string]any{"type": "metrics", "samples": samples}
	raw, err := json.Marshal(body)
	if err == nil && len(raw) > 32_768 && len(samples) > 4 {
		body["samples"] = samples[:4]
	}
	return body
}

func serviceUp(name string) float64 {
	if runtime.GOOS == "windows" {
		info, err := svcctl.Query(name)
		if err != nil {
			return -1
		}
		if strings.EqualFold(info.Status, "running") {
			return 1
		}
		return 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "systemctl", "is-active", "--quiet", name)
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return -1
		}
		return 0
	}
	return 1
}
