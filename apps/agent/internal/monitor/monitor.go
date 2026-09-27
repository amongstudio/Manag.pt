package monitor

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
	"github.com/shirou/gopsutil/v4/sensors"
)

const extrasCap = 32_768
const processCacheTTL = 12 * time.Second
const cpuSampleInterval = 250 * time.Millisecond
const watchedProcessCap = 10

type Mode string

const (
	ModeIdle    Mode = "idle"
	ModeWatched Mode = "watched"
	ModeFull    Mode = "full"
)

type Options struct {
	Mode        Mode
	EnableGPU   bool
	EnableTemps bool
}

type ProcessInfo struct {
	PID  int32   `json:"pid"`
	Name string  `json:"name"`
	CPU  float64 `json:"cpu"`
	RAM  float32 `json:"ram"`
}

type ExtrasCPU struct {
	PerCore []float64 `json:"perCore"`
	Model   string    `json:"model,omitempty"`
	FreqMhz float64   `json:"freqMhz,omitempty"`
}

type ExtrasMem struct {
	Used            uint64  `json:"used"`
	Available       uint64  `json:"available"`
	Total           uint64  `json:"total"`
	SwapUsedPercent float64 `json:"swapUsedPercent"`
}

type ExtrasPart struct {
	Device      string  `json:"device"`
	Mount       string  `json:"mount"`
	Fstype      string  `json:"fstype"`
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	UsedPercent float64 `json:"usedPercent"`
}

type ExtrasDiskIO struct {
	Name             string  `json:"name"`
	ReadBytesPerSec  float64 `json:"readBytesPerSec"`
	WriteBytesPerSec float64 `json:"writeBytesPerSec"`
}

type ExtrasDisk struct {
	Partitions []ExtrasPart   `json:"partitions"`
	IO         []ExtrasDiskIO `json:"io"`
}

type ExtrasGPU struct {
	Util     *float64 `json:"util,omitempty"`
	MemUsed  *float64 `json:"memUsed,omitempty"`
	MemTotal *float64 `json:"memTotal,omitempty"`
	Temp     *float64 `json:"temp,omitempty"`
}

type ExtrasNet struct {
	Name string  `json:"name"`
	Up   float64 `json:"up"`
	Down float64 `json:"down"`
}

type ExtrasTemp struct {
	Key string  `json:"key"`
	C   float64 `json:"c"`
}

type Extras struct {
	CPU            ExtrasCPU     `json:"cpu"`
	Memory         ExtrasMem     `json:"memory"`
	Disk           ExtrasDisk    `json:"disk"`
	GPU            *ExtrasGPU    `json:"gpu,omitempty"`
	Net            []ExtrasNet   `json:"net"`
	Temps          []ExtrasTemp  `json:"temps"`
	ProcessesByRam []ProcessInfo `json:"processesByRam"`
}

type Snapshot struct {
	CPU       float64       `json:"cpu"`
	RAM       float64       `json:"ram"`
	Disk      float64       `json:"disk"`
	GPU       *float64      `json:"gpu,omitempty"`
	Temp      *float64      `json:"temp,omitempty"`
	NetUp     float64       `json:"netUp,omitempty"`
	NetDown   float64       `json:"netDown,omitempty"`
	Processes []ProcessInfo `json:"processes"`
	Extras    *Extras       `json:"extras,omitempty"`
}

var (
	netMu      sync.Mutex
	lastNetAt  time.Time
	lastSent   uint64
	lastRecv   uint64
	lastIfaces map[string]net.IOCountersStat

	diskMu     sync.Mutex
	lastDiskAt time.Time
	lastDisk   map[string]disk.IOCountersStat

	procMu      sync.Mutex
	procCache   []ProcessInfo
	procCacheAt time.Time

	cpuMu         sync.Mutex
	cpuCacheCore  []float64
	cpuCacheTotal float64
	cpuCacheAt    time.Time
	cpuInfoOnce   sync.Once
	cpuInfoCache  []cpu.InfoStat

	partMu    sync.Mutex
	partCache []ExtrasPart
	partAt    time.Time

	sensorMu    sync.Mutex
	sensorCache []sensors.TemperatureStat
	sensorAt    time.Time

	nvidiaOnce   sync.Once
	nvidiaBin    string
	nvidiaAbsent bool
)

func Collect(opts Options) Snapshot {
	if opts.Mode == "" {
		opts.Mode = ModeWatched
	}
	if opts.Mode == ModeIdle {
		return collectIdle()
	}
	procN := watchedProcessCap
	if opts.Mode == ModeFull {
		procN = 25
	}
	total, perCore := cachedCPU()
	all := cachedProcesses()
	snap := Snapshot{CPU: total, Processes: topN(all, procN, true)}
	extras := &Extras{
		CPU:            ExtrasCPU{PerCore: perCore},
		Disk:           ExtrasDisk{Partitions: cachedPartitions(), IO: diskRates()},
		Net:            ifaceRates(),
		ProcessesByRam: topN(all, procN, false),
	}
	if opts.EnableTemps {
		extras.Temps = tempList()
	}
	if infos := cachedCPUInfo(); len(infos) > 0 {
		extras.CPU.Model = infos[0].ModelName
		extras.CPU.FreqMhz = infos[0].Mhz
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		snap.RAM = vm.UsedPercent
		extras.Memory = ExtrasMem{Used: vm.Used, Available: vm.Available, Total: vm.Total}
	}
	if sm, err := mem.SwapMemory(); err == nil {
		extras.Memory.SwapUsedPercent = sm.UsedPercent
	}
	path := "/"
	if runtime.GOOS == "windows" {
		path = "C:\\"
	}
	if d, err := disk.Usage(path); err == nil {
		snap.Disk = d.UsedPercent
	}
	up, down := netBytesPerSec()
	snap.NetUp = up
	snap.NetDown = down
	if opts.EnableGPU {
		gpu := gpuStats()
		if gpu != nil {
			snap.GPU = gpu.Util
			extras.GPU = gpu
		}
	}
	if opts.EnableTemps {
		snap.Temp = cpuTemp()
	}
	snap.Extras = capExtras(extras)
	return snap
}

func collectIdle() Snapshot {
	snap := Snapshot{Processes: []ProcessInfo{}}
	snap.CPU = cpuTotalNonBlocking()
	if vm, err := mem.VirtualMemory(); err == nil {
		snap.RAM = vm.UsedPercent
	}
	path := "/"
	if runtime.GOOS == "windows" {
		path = "C:\\"
	}
	if d, err := disk.Usage(path); err == nil {
		snap.Disk = d.UsedPercent
	}
	return snap
}

func cpuTotalNonBlocking() float64 {
	now := time.Now()
	cpuMu.Lock()
	if !cpuCacheAt.IsZero() && now.Sub(cpuCacheAt) < processCacheTTL {
		total := cpuCacheTotal
		cpuMu.Unlock()
		return total
	}
	cpuMu.Unlock()
	sampled, _ := cpu.Percent(0, false)
	total := 0.0
	if len(sampled) > 0 {
		total = sampled[0]
	}
	cpuMu.Lock()
	cpuCacheTotal = total
	cpuCacheAt = time.Now()
	cpuMu.Unlock()
	return total
}

func capExtras(ex *Extras) *Extras {
	if ex == nil {
		return nil
	}
	raw, err := json.Marshal(ex)
	if err != nil || len(raw) <= extrasCap {
		return ex
	}
	ex.ProcessesByRam = nil
	raw, err = json.Marshal(ex)
	if err != nil || len(raw) <= extrasCap {
		return ex
	}
	ex.Temps = nil
	raw, err = json.Marshal(ex)
	if err != nil || len(raw) <= extrasCap {
		return ex
	}
	ex.CPU.PerCore = nil
	return ex
}

func cachedCPU() (total float64, perCore []float64) {
	now := time.Now()
	cpuMu.Lock()
	if !cpuCacheAt.IsZero() && now.Sub(cpuCacheAt) < processCacheTTL {
		total = cpuCacheTotal
		perCore = append([]float64(nil), cpuCacheCore...)
		cpuMu.Unlock()
		return total, perCore
	}
	cpuMu.Unlock()

	sampled, _ := cpu.Percent(cpuSampleInterval, true)
	if len(sampled) > 0 {
		var sum float64
		for _, v := range sampled {
			sum += v
		}
		total = sum / float64(len(sampled))
	}
	cpuMu.Lock()
	cpuCacheCore = append([]float64(nil), sampled...)
	cpuCacheTotal = total
	cpuCacheAt = time.Now()
	cpuMu.Unlock()
	return total, sampled
}

func cachedProcesses() []ProcessInfo {
	now := time.Now()
	procMu.Lock()
	if !procCacheAt.IsZero() && now.Sub(procCacheAt) < processCacheTTL {
		out := append([]ProcessInfo(nil), procCache...)
		procMu.Unlock()
		return out
	}
	procMu.Unlock()

	list := allProcesses()

	procMu.Lock()
	procCache = append([]ProcessInfo(nil), list...)
	procCacheAt = time.Now()
	procMu.Unlock()
	return list
}

func allProcesses() []ProcessInfo {
	procs, err := process.Processes()
	if err != nil {
		return []ProcessInfo{}
	}
	list := make([]ProcessInfo, 0, 32)
	for _, p := range procs {
		name, _ := p.Name()
		cpuP, _ := p.CPUPercent()
		memP, _ := p.MemoryPercent()
		list = append(list, ProcessInfo{PID: p.Pid, Name: name, CPU: cpuP, RAM: memP})
	}
	return list
}

func TopProcesses() []ProcessInfo {
	return topN(cachedProcesses(), 25, true)
}

func TopProcessesByRAM() []ProcessInfo {
	return topN(cachedProcesses(), 25, false)
}

func topN(list []ProcessInfo, n int, byCPU bool) []ProcessInfo {
	cp := append([]ProcessInfo(nil), list...)
	if byCPU {
		sort.Slice(cp, func(i, j int) bool { return cp[i].CPU > cp[j].CPU })
	} else {
		sort.Slice(cp, func(i, j int) bool { return cp[i].RAM > cp[j].RAM })
	}
	if len(cp) > n {
		cp = cp[:n]
	}
	if cp == nil {
		return []ProcessInfo{}
	}
	return cp
}

func cachedCPUInfo() []cpu.InfoStat {
	cpuInfoOnce.Do(func() {
		infos, err := cpu.Info()
		if err == nil {
			cpuInfoCache = infos
		}
	})
	return cpuInfoCache
}

func cachedPartitions() []ExtrasPart {
	partMu.Lock()
	if time.Since(partAt) < 45*time.Second && partCache != nil {
		out := partCache
		partMu.Unlock()
		return out
	}
	partMu.Unlock()
	next := partitions()
	partMu.Lock()
	partCache = next
	partAt = time.Now()
	partMu.Unlock()
	return next
}

func cachedSensors() []sensors.TemperatureStat {
	sensorMu.Lock()
	if time.Since(sensorAt) < 15*time.Second && sensorCache != nil {
		out := sensorCache
		sensorMu.Unlock()
		return out
	}
	sensorMu.Unlock()
	stats, err := sensors.SensorsTemperatures()
	if err != nil {
		return nil
	}
	sensorMu.Lock()
	sensorCache = stats
	sensorAt = time.Now()
	sensorMu.Unlock()
	return stats
}

func partitions() []ExtrasPart {
	parts, err := disk.Partitions(false)
	if err != nil {
		return nil
	}
	out := make([]ExtrasPart, 0, len(parts))
	for _, p := range parts {
		u, err := disk.Usage(p.Mountpoint)
		if err != nil {
			continue
		}
		out = append(out, ExtrasPart{
			Device:      p.Device,
			Mount:       p.Mountpoint,
			Fstype:      p.Fstype,
			Total:       u.Total,
			Used:        u.Used,
			UsedPercent: u.UsedPercent,
		})
		if len(out) >= 24 {
			break
		}
	}
	return out
}

func diskRates() []ExtrasDiskIO {
	counters, err := disk.IOCounters()
	if err != nil || len(counters) == 0 {
		return nil
	}
	now := time.Now()
	diskMu.Lock()
	defer diskMu.Unlock()
	if lastDiskAt.IsZero() {
		lastDiskAt = now
		lastDisk = counters
		return nil
	}
	elapsed := now.Sub(lastDiskAt).Seconds()
	out := make([]ExtrasDiskIO, 0, len(counters))
	for name, cur := range counters {
		prev, ok := lastDisk[name]
		item := ExtrasDiskIO{Name: name}
		if ok && elapsed > 0 {
			item.ReadBytesPerSec = bytesPerSec(cur.ReadBytes, prev.ReadBytes, elapsed)
			item.WriteBytesPerSec = bytesPerSec(cur.WriteBytes, prev.WriteBytes, elapsed)
		}
		out = append(out, item)
		if len(out) >= 16 {
			break
		}
	}
	lastDiskAt = now
	lastDisk = counters
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func netBytesPerSec() (up, down float64) {
	counters, err := net.IOCounters(false)
	if err != nil || len(counters) == 0 {
		return 0, 0
	}
	now := time.Now()
	sent := counters[0].BytesSent
	recv := counters[0].BytesRecv
	netMu.Lock()
	defer netMu.Unlock()
	if lastNetAt.IsZero() {
		lastNetAt = now
		lastSent = sent
		lastRecv = recv
		return 0, 0
	}
	elapsed := now.Sub(lastNetAt).Seconds()
	up = bytesPerSec(sent, lastSent, elapsed)
	down = bytesPerSec(recv, lastRecv, elapsed)
	lastNetAt = now
	lastSent = sent
	lastRecv = recv
	return up, down
}

func ifaceRates() []ExtrasNet {
	counters, err := net.IOCounters(true)
	if err != nil {
		return nil
	}
	now := time.Now()
	netMu.Lock()
	defer netMu.Unlock()
	elapsed := now.Sub(lastNetAt).Seconds()
	out := make([]ExtrasNet, 0, len(counters))
	for _, cur := range counters {
		item := ExtrasNet{Name: cur.Name}
		if lastIfaces != nil && elapsed > 0 {
			if prev, ok := lastIfaces[cur.Name]; ok {
				item.Up = bytesPerSec(cur.BytesSent, prev.BytesSent, elapsed)
				item.Down = bytesPerSec(cur.BytesRecv, prev.BytesRecv, elapsed)
			}
		}
		out = append(out, item)
		if len(out) >= 16 {
			break
		}
	}
	next := make(map[string]net.IOCountersStat, len(counters))
	for _, c := range counters {
		next[c.Name] = c
	}
	lastIfaces = next
	return out
}

func bytesPerSec(curr, prev uint64, elapsed float64) float64 {
	if elapsed <= 0 || curr < prev {
		return 0
	}
	return float64(curr-prev) / elapsed
}

func tempList() []ExtrasTemp {
	stats := cachedSensors()
	if len(stats) == 0 {
		return nil
	}
	out := make([]ExtrasTemp, 0, 8)
	for _, s := range stats {
		if s.Temperature <= 0 || s.Temperature > 200 {
			continue
		}
		out = append(out, ExtrasTemp{Key: s.SensorKey, C: s.Temperature})
		if len(out) >= 16 {
			break
		}
	}
	return out
}

func cpuTemp() *float64 {
	stats := cachedSensors()
	if len(stats) == 0 {
		return nil
	}
	var preferred float64
	var foundPreferred bool
	var any float64
	var foundAny bool
	for _, s := range stats {
		if s.Temperature <= 0 || s.Temperature > 200 {
			continue
		}
		if !foundAny || s.Temperature > any {
			any = s.Temperature
			foundAny = true
		}
		key := strings.ToLower(s.SensorKey)
		if strings.Contains(key, "cpu") ||
			strings.Contains(key, "core") ||
			strings.Contains(key, "package") ||
			strings.Contains(key, "k10") ||
			strings.Contains(key, "coretemp") ||
			strings.Contains(key, "zenpower") ||
			strings.Contains(key, "acpitz") {
			if !foundPreferred || s.Temperature > preferred {
				preferred = s.Temperature
				foundPreferred = true
			}
		}
	}
	if foundPreferred {
		return &preferred
	}
	if foundAny {
		return &any
	}
	return nil
}

func gpuStats() *ExtrasGPU {
	if v := amdGPU(); v != nil {
		return v
	}
	return nvidiaGPU()
}

func gpuUtil() *float64 {
	g := gpuStats()
	if g == nil {
		return nil
	}
	return g.Util
}

func amdGPU() *ExtrasGPU {
	matches, err := filepath.Glob("/sys/class/drm/card*/device/gpu_busy_percent")
	if err != nil || len(matches) == 0 {
		return nil
	}
	raw, err := os.ReadFile(matches[0])
	if err != nil {
		return nil
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	if err != nil || v < 0 || v > 100 {
		return nil
	}
	out := &ExtrasGPU{Util: &v}
	base := filepath.Dir(matches[0])
	if usedRaw, err := os.ReadFile(filepath.Join(base, "mem_info_vram_used")); err == nil {
		if n, err := strconv.ParseFloat(strings.TrimSpace(string(usedRaw)), 64); err == nil {
			mb := n / (1024 * 1024)
			out.MemUsed = &mb
		}
	}
	if totalRaw, err := os.ReadFile(filepath.Join(base, "mem_info_vram_total")); err == nil {
		if n, err := strconv.ParseFloat(strings.TrimSpace(string(totalRaw)), 64); err == nil {
			mb := n / (1024 * 1024)
			out.MemTotal = &mb
		}
	}
	if hw, err := filepath.Glob(filepath.Join(base, "hwmon/hwmon*/temp1_input")); err == nil && len(hw) > 0 {
		if tRaw, err := os.ReadFile(hw[0]); err == nil {
			if n, err := strconv.ParseFloat(strings.TrimSpace(string(tRaw)), 64); err == nil && n > 0 {
				c := n / 1000
				out.Temp = &c
			}
		}
	}
	return out
}

func nvidiaGPU() *ExtrasGPU {
	nvidiaOnce.Do(func() {
		bin, skip := detectNvidia()
		nvidiaAbsent = skip
		nvidiaBin = bin
	})
	if nvidiaAbsent || nvidiaBin == "" {
		return nil
	}
	bin := nvidiaBin
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits").Output()
	if err != nil {
		return nvidiaUtilOnly(bin)
	}
	line := strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
	parts := strings.Split(line, ",")
	if len(parts) < 1 {
		return nil
	}
	g := &ExtrasGPU{}
	if v, err := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64); err == nil && v >= 0 && v <= 100 {
		g.Util = &v
	}
	if len(parts) > 1 {
		if v, err := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64); err == nil && v >= 0 {
			g.MemUsed = &v
		}
	}
	if len(parts) > 2 {
		if v, err := strconv.ParseFloat(strings.TrimSpace(parts[2]), 64); err == nil && v >= 0 {
			g.MemTotal = &v
		}
	}
	if len(parts) > 3 {
		if v, err := strconv.ParseFloat(strings.TrimSpace(parts[3]), 64); err == nil && v > 0 && v < 200 {
			g.Temp = &v
		}
	}
	if g.Util == nil && g.MemUsed == nil && g.Temp == nil {
		return nil
	}
	return g
}

func nvidiaUtilOnly(bin string) *ExtrasGPU {
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits").Output()
	if err != nil {
		return nil
	}
	line := strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
	v, err := strconv.ParseFloat(line, 64)
	if err != nil || v < 0 || v > 100 {
		return nil
	}
	return &ExtrasGPU{Util: &v}
}

func detectNvidia() (bin string, skip bool) {
	switch runtime.GOOS {
	case "linux":
		present := false
		if _, err := os.Stat("/proc/driver/nvidia"); err == nil {
			present = true
		} else if nvidiaPCI() {
			present = true
		}
		if !present {
			return "", true
		}
	case "windows":
		ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
		defer cancel()
		if err := exec.CommandContext(ctx, "where", "nvidia-smi").Run(); err != nil {
			return "", true
		}
	}
	path, err := exec.LookPath("nvidia-smi")
	if err != nil {
		return "", true
	}
	return path, false
}

func nvidiaPCI() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "lspci").Output()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(out)), "nvidia")
}
