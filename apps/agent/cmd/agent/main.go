package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/kardianos/service"
	"github.com/pc-manager/agent/internal/agentws"
	"github.com/pc-manager/agent/internal/capture"
	"github.com/pc-manager/agent/internal/client"
	"github.com/pc-manager/agent/internal/commands"
	"github.com/pc-manager/agent/internal/config"
	"github.com/pc-manager/agent/internal/desktop"
	"github.com/pc-manager/agent/internal/e2e"
	"github.com/pc-manager/agent/internal/filemanager"
	"github.com/pc-manager/agent/internal/inventory"
	"github.com/pc-manager/agent/internal/lan"
	"github.com/pc-manager/agent/internal/logger"
	"github.com/pc-manager/agent/internal/mesh"
	"github.com/pc-manager/agent/internal/metrics"
	"github.com/pc-manager/agent/internal/notify"
	"github.com/pc-manager/agent/internal/screenshot"
	"github.com/pc-manager/agent/internal/shell"
	"github.com/pc-manager/agent/internal/transfer"
	"github.com/pc-manager/agent/internal/tray"
	"github.com/pc-manager/agent/internal/updater"
	"github.com/pc-manager/agent/internal/winsvc"
	"github.com/pc-manager/agent/internal/wsprotocol"
)

var Version = "3.4.0"

func init() {
	inventory.AgentVersion = Version
}

const (
	fastPoolSize = 8
	longPoolSize = 2
)

type program struct {
	cfg           *config.Config
	log           *logger.AgentLog
	api           *client.Client
	stopCh        chan struct{}
	watchMu       sync.Mutex
	watchEvery    time.Duration
	watchWake     chan struct{}
	lastEndpoint  string
	lastRestart   string
	hbMu          sync.Mutex
	lastHeartbeat time.Time
	lastMetrics   time.Time
	started       time.Time
	hbWake        chan struct{}
	inFlight      atomic.Int32
	exclusive     sync.Mutex
	longWG        sync.WaitGroup
	longSem       chan struct{}
	fastSem       chan struct{}
	sandboxMu     sync.Mutex
	sandbox       *filemanager.Sandbox
	ws            *agentws.Client
	e2e           *e2e.Box
	desk          *desktop.Session
	xfer          *transfer.Engine
	sh            *shell.Manager
	mesh          *mesh.Manager
	lastErrMu     sync.Mutex
	lastError     string
}

func (p *program) setLastError(msg string) {
	p.lastErrMu.Lock()
	p.lastError = msg
	p.lastErrMu.Unlock()
}

func (p *program) getLastError() string {
	p.lastErrMu.Lock()
	defer p.lastErrMu.Unlock()
	return p.lastError
}

func (p *program) Start(s service.Service) error {
	p.stopCh = make(chan struct{})
	p.watchWake = make(chan struct{}, 1)
	p.hbWake = make(chan struct{}, 1)
	p.longSem = make(chan struct{}, longPoolSize)
	p.fastSem = make(chan struct{}, fastPoolSize)
	go p.run()
	return nil
}

func (p *program) Stop(s service.Service) error {
	if p.cfg != nil {
		notify.MarkCleanStop(p.cfg.DataDir)
	}
	defer capture.Shutdown()
	if p.stopCh != nil {
		select {
		case <-p.stopCh:
		default:
			close(p.stopCh)
		}
	}
	if p.desk != nil {
		p.desk.Close()
	}
	if p.sh != nil {
		p.sh.Close()
	}
	if p.mesh != nil {
		p.mesh.Stop()
	}
	if p.ws != nil {
		// Run() observes stopCh and closes the socket.
	}
	done := make(chan struct{})
	go func() {
		p.longWG.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		if p.log != nil {
			p.log.Note("WARNING", "stop: timed out waiting for in-flight jobs")
		}
	}
	return nil
}

func (p *program) applyWatched(names []string) {
	p.cfg.Lock()
	p.cfg.WatchedServiceNames = append([]string(nil), names...)
	p.cfg.Unlock()
	_ = p.cfg.Save()
}

func applyAgentConfig(cfg *config.Config, ac *client.AgentConfig) bool {
	if ac == nil {
		return false
	}
	cfg.Lock()
	defer cfg.Unlock()
	changed := false
	if ac.HeartbeatIntervalSec > 0 && cfg.HeartbeatIntervalSec != ac.HeartbeatIntervalSec {
		cfg.HeartbeatIntervalSec = ac.HeartbeatIntervalSec
		changed = true
	}
	if ac.IdleHeartbeatSec > 0 && cfg.IdleHeartbeatSec != ac.IdleHeartbeatSec {
		cfg.IdleHeartbeatSec = ac.IdleHeartbeatSec
		changed = true
	}
	if ac.WatchedHeartbeatSec > 0 && cfg.WatchedHeartbeatSec != ac.WatchedHeartbeatSec {
		cfg.WatchedHeartbeatSec = ac.WatchedHeartbeatSec
		changed = true
	}
	if ac.Lightweight != nil && cfg.Lightweight != *ac.Lightweight {
		cfg.Lightweight = *ac.Lightweight
		changed = true
	}
	if ac.PollIntervalSec > 0 && cfg.PollIntervalSec != ac.PollIntervalSec {
		cfg.PollIntervalSec = ac.PollIntervalSec
		changed = true
	}
	if ac.ScreenshotIntervalSec != nil && cfg.ScreenshotIntervalSec != *ac.ScreenshotIntervalSec {
		cfg.ScreenshotIntervalSec = *ac.ScreenshotIntervalSec
		changed = true
	}
	if ac.AutoRestartTime != nil && cfg.AutoRestartTime != *ac.AutoRestartTime {
		cfg.AutoRestartTime = *ac.AutoRestartTime
		changed = true
	}
	if ac.SandboxRoots != nil && !sameStrings(cfg.SandboxRoots, ac.SandboxRoots) {
		cfg.SandboxRoots = append([]string(nil), ac.SandboxRoots...)
		changed = true
	}
	return changed
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (p *program) signalWatch() {
	select {
	case p.watchWake <- struct{}{}:
	default:
	}
}

func (p *program) setWatchEvery(interval time.Duration) {
	p.watchMu.Lock()
	changed := p.watchEvery != interval
	p.watchEvery = interval
	p.watchMu.Unlock()
	if changed {
		p.signalWatch()
	}
}

func (p *program) watched() bool {
	return p.watchInterval() > 0 || p.inFlight.Load() > 0
}

func (p *program) heartbeatInterval() time.Duration {
	sec := p.cfg.IdleHeartbeatSec
	if p.watched() {
		sec = p.cfg.WatchedHeartbeatSec
	}
	if sec <= 0 {
		sec = p.cfg.HeartbeatIntervalSec
	}
	if sec < 5 {
		sec = 5
	}
	return time.Duration(sec) * time.Second
}

func (p *program) signalHeartbeat() {
	if p.hbWake == nil {
		return
	}
	select {
	case p.hbWake <- struct{}{}:
	default:
	}
}

func (p *program) applyRemoteConfig(ac *client.AgentConfig, watch *client.WatchConfig) {
	if ac != nil && ac.MaxUploadBytes > 0 {
		client.ApplyMaxUploadBytes(ac.MaxUploadBytes)
	}
	if watch != nil && watch.IntervalMs > 0 {
		interval := time.Duration(watch.IntervalMs) * time.Millisecond
		if interval < time.Second {
			interval = time.Second
		}
		p.setWatchEvery(interval)
	} else {
		p.setWatchEvery(0)
	}
	p.signalHeartbeat()
	if ac != nil && ac.Mesh != nil && p.mesh != nil {
		p.mesh.SetPolicy(mesh.Policy{
			Enabled:       ac.Mesh.Enabled,
			WAN:           ac.Mesh.WAN,
			AllowCommands: append([]string(nil), ac.Mesh.AllowCommands...),
		})
	}
	if applyAgentConfig(p.cfg, ac) {
		if err := p.cfg.Save(); err != nil {
			p.log.Notef("WARNING", "save config: %v", err)
		} else {
			sb := filemanager.New(p.cfg.SandboxRoots, p.cfg.DataDir)
			p.sandboxMu.Lock()
			p.sandbox = sb
			p.sandboxMu.Unlock()
			p.log.Note("INFO", "applied server agentConfig")
			p.signalWatch()
		}
	}
}

func (p *program) heartbeat(api *client.Client, sandbox **filemanager.Sandbox) {
	lg := p.log
	wsUp := p.ws != nil && p.ws.Connected()
	if !wsUp {
		if endpoint, err := api.Probe(); err != nil {
			lg.Notef("WARNING", "connectivity probe failed: %v", err)
		} else if endpoint != p.lastEndpoint {
			lg.Notef("INFO", "active endpoint %s", endpoint)
			p.lastEndpoint = endpoint
		}
	}
	presence := map[string]any{
		"type":     wsprotocol.TypeHeartbeat,
		"lanAddrs": lan.Addrs(),
		"lanPort":  lan.Port(),
	}
	if p.ws != nil && p.ws.Connected() {
		if err := p.ws.SendHeartbeat(presence); err == nil {
			p.hbMu.Lock()
			p.lastHeartbeat = time.Now()
			p.hbMu.Unlock()
			entries := lg.Drain()
			if err := api.Logs(entries); err != nil {
				lg.Restore(entries)
				lg.Printf("log ship: %v", err)
			}
			p.pushMetrics(api)
			return
		} else {
			lg.Notef("WARNING", "ws heartbeat: %v", err)
		}
	}
	resp, err := api.Heartbeat(presence)
	if err != nil {
		lg.Notef("WARNING", "heartbeat: %v", err)
		p.setLastError(err.Error())
		return
	}
	p.setLastError("")
	p.hbMu.Lock()
	p.lastHeartbeat = time.Now()
	p.hbMu.Unlock()
	p.applyRemoteConfig(resp.AgentConfig, resp.Watch)
	if sandbox != nil && p.sandbox != nil {
		*sandbox = p.sandbox
	}
	entries := lg.Drain()
	if err := api.Logs(entries); err != nil {
		lg.Restore(entries)
		lg.Printf("log ship: %v", err)
	}
	p.pushMetrics(api)
}

func (p *program) pushMetrics(api *client.Client) {
	p.hbMu.Lock()
	if !p.lastMetrics.IsZero() && time.Since(p.lastMetrics) < 60*time.Second {
		p.hbMu.Unlock()
		return
	}
	p.lastMetrics = time.Now()
	started := p.started
	p.hbMu.Unlock()
	p.cfg.RLock()
	services := append([]string(nil), p.cfg.WatchedServiceNames...)
	p.cfg.RUnlock()
	body := metrics.SampleHost(services, started)
	if p.ws != nil && p.ws.Connected() {
		if err := p.ws.SendJSON(body); err == nil {
			return
		}
	}
	if err := api.PostMetrics(body); err != nil && p.log != nil {
		p.log.Notef("WARNING", "metrics: %v", err)
	}
}

func (p *program) run() {
	lg := p.log
	p.started = time.Now()
	api := client.New(p.cfg)
	p.api = api
	sandbox := filemanager.New(p.cfg.SandboxRoots, p.cfg.DataDir)
	p.sandbox = sandbox
	p.mesh = mesh.New(p.cfg.DataDir, p.cfg.DeviceID, func() *filemanager.Sandbox {
		p.sandboxMu.Lock()
		defer p.sandboxMu.Unlock()
		return p.sandbox
	}, func(format string, args ...any) {
		p.log.Notef("INFO", format, args...)
	})
	go p.serveStatus()
	notify.Configure(notify.Options{StatusPort: p.cfg.StatusPort, DataDir: p.cfg.DataDir})
	notify.Logf = func(format string, args ...any) {
		p.log.Notef("INFO", format, args...)
	}
	if notify.TakeUncleanStart(p.cfg.DataDir) {
		notify.PostKind(notify.KindAgentRecovering)
	}
	notify.MarkAlive(p.cfg.DataDir)
	if _, changed := notify.NoteVersion(p.cfg.DataDir, Version); changed {
		notify.PostKind(notify.KindUpdateApplied)
	}
	notify.EnsureTray()

	box, err := e2e.LoadOrCreate(p.cfg.DataDir)
	if err != nil {
		lg.Notef("WARNING", "e2e keys: %v", err)
	} else {
		p.e2e = box
	}

	if p.cfg.DeviceID == "" || p.cfg.DeviceKey == "" {
		if p.cfg.DeviceKey == "" && p.cfg.DeviceID != "" {
			lg.Note("WARNING", "device id present without enrollment key; requesting a new identity")
			p.cfg.DeviceID = ""
		}
		if err := p.enrollUntilReady(&api); err != nil {
			lg.Notef("WARNING", "not enrolled yet: %v", err)
			p.setLastError(err.Error())
			<-p.stopCh
			return
		}
		p.api = api
	}

	if p.mesh != nil {
		p.mesh.SetDeviceID(p.cfg.DeviceID)
		p.mesh.StartFromDisk()
	}

	p.ws = agentws.New(p.cfg, api, lg, Version, p.applyRemoteConfig)
	go p.watchWSToasts()
	if p.e2e != nil {
		p.ws.SetE2EPub(p.e2e.PubHex())
	}
	p.ws.SetMeshSerial(func() string {
		if p.mesh == nil {
			return ""
		}
		return p.mesh.Serial()
	})
	p.ws.SetOnHello(func(ok wsprotocol.HelloOK) {
		if p.mesh != nil {
			if ok.Mesh != nil {
				p.mesh.Install(meshBundleFromWS(ok.Mesh))
			}
			p.mesh.ApplyWAN(iceFromWS(ok.IceServers), ok.IP, hintsFromWS(ok.MeshPeers))
		}
		p.flushMeshAudit(api)
	})
	p.desk = desktop.New(lg, p.sendDesktopSignal, "")
	p.xfer = transfer.New(api, p.ws, p.e2e)
	p.sh = shell.New(lg, func(v any) {
		if p.ws != nil {
			_ = p.ws.SendJSON(v)
		}
	})
	p.ws.SetHandlers(agentws.Handlers{
		OnWebrtc: func(payload json.RawMessage) {
			if !p.cfg.EnableWebrtc {
				p.refuseWebrtc()
				return
			}
			if p.desk != nil {
				p.desk.Handle(payload)
			}
		},
		OnMeshSignal: func(payload json.RawMessage) {
			if p.mesh != nil {
				p.mesh.HandleSignal(payload)
			}
		},
		OnMeshRelay: func(payload json.RawMessage) {
			if p.mesh != nil {
				p.mesh.HandleRelay(payload)
			}
		},
		OnMeshRelayResult: func(payload json.RawMessage) {
			if p.mesh != nil {
				p.mesh.HandleRelayResult(payload)
			}
		},
		OnE2E:       p.onE2E,
		OnFileChunk: p.xfer.Handle,
		OnShell:     p.sh.Handle,
	})
	if p.mesh != nil {
		p.mesh.SetExec(func(typ string, payload json.RawMessage) (any, error) {
			p.sandboxMu.Lock()
			sb := p.sandbox
			p.sandboxMu.Unlock()
			return commands.Handle(typ, payload, commands.Deps{
				Client:        p.api,
				Sandbox:       sb,
				Version:       Version,
				DataDir:       p.cfg.DataDir,
				EnablePlugins: p.cfg.EnablePlugins,
				Transfer:      p.xfer,
				DeviceID:      p.cfg.DeviceID,
				ApplyWatched:  p.applyWatched,
			})
		})
		p.mesh.SetSignal(func(v any) error {
			if p.ws == nil || !p.ws.Connected() {
				return fmt.Errorf("agent-ws not connected")
			}
			return p.ws.SendJSON(v)
		})
	}
	go p.watchLoop()
	go p.scheduleLoop()
	go p.ws.Run(p.stopCh)
	go p.pollFallback(api)

	p.heartbeat(api, &sandbox)

	go func() {
		for {
			interval := p.heartbeatInterval()
			t := time.NewTimer(interval)
			select {
			case <-p.stopCh:
				t.Stop()
				return
			case <-p.hbWake:
				t.Stop()
				p.heartbeat(api, &sandbox)
			case <-t.C:
				p.heartbeat(api, &sandbox)
			}
		}
	}()

	for {
		select {
		case <-p.stopCh:
			if p.desk != nil {
				p.desk.Close()
			}
			if p.sh != nil {
				p.sh.Close()
			}
			capture.Shutdown()
			return
		case cmd := <-p.ws.Commands():
			p.sandboxMu.Lock()
			sb := p.sandbox
			p.sandboxMu.Unlock()
			p.dispatch(api, sb, cmd)
		}
	}
}

func (p *program) pollFallback(api *client.Client) {
	lg := p.log
	for {
		select {
		case <-p.stopCh:
			return
		default:
		}
		if p.ws.Connected() || !p.ws.ShouldFallback() {
			t := time.NewTimer(15 * time.Second)
			select {
			case <-p.stopCh:
				t.Stop()
				return
			case <-t.C:
			}
			continue
		}
		cmds, err := api.PollCommands(25)
		if err != nil {
			lg.Notef("WARNING", "poll: %v", err)
			delay := time.Duration(p.cfg.PollIntervalSec) * time.Second
			if delay < time.Second {
				delay = time.Second
			}
			t := time.NewTimer(delay)
			select {
			case <-p.stopCh:
				t.Stop()
				return
			case <-t.C:
			}
			continue
		}
		for _, cmd := range cmds {
			if !p.ws.Submit(cmd, p.stopCh) {
				return
			}
		}
	}
}

func (p *program) dispatch(api *client.Client, sandbox *filemanager.Sandbox, cmd client.Command) {
	switch commands.Classify(cmd.Type) {
	case commands.ClassExclusive:
		go func() {
			p.exclusive.Lock()
			defer p.exclusive.Unlock()
			p.longWG.Wait()
			p.runOne(api, sandbox, cmd)
		}()
	case commands.ClassLong:
		go func() {
			p.exclusive.Lock()
			p.longWG.Add(1)
			p.exclusive.Unlock()
			defer p.longWG.Done()
			p.longSem <- struct{}{}
			defer func() { <-p.longSem }()
			p.runOne(api, sandbox, cmd)
		}()
	default:
		go func() {
			p.fastSem <- struct{}{}
			defer func() { <-p.fastSem }()
			p.runOne(api, sandbox, cmd)
		}()
	}
}

func (p *program) runOne(api *client.Client, sandbox *filemanager.Sandbox, cmd client.Command) {
	p.inFlight.Add(1)
	defer p.inFlight.Add(-1)
	resultID := uuid.NewString()
	reported := false
	defer func() {
		if rec := recover(); rec != nil {
			p.log.Notef("ERROR", "command %s %s panic: %v", cmd.ID, cmd.Type, rec)
			if !reported {
				p.reportResult(api, cmd.ID, resultID, "failed", map[string]string{"error": fmt.Sprintf("panic: %v", rec)})
			}
		}
	}()
	deps := commands.Deps{
		Client:        api,
		Sandbox:       sandbox,
		Version:       Version,
		DataDir:       p.cfg.DataDir,
		EnablePlugins: p.cfg.EnablePlugins,
		ApplyWatched:  p.applyWatched,
		Progress: func(n int) {
			p.reportProgress(api, cmd.ID, resultID, n)
		},
		Transfer: p.xfer,
		DeviceID: p.cfg.DeviceID,
		Mesh:     p.mesh,
	}
	var result any
	var handleErr error
	local := true
	if dest := mesh.ForwardTarget(cmd.Payload); dest != "" {
		local = false
		inner := mesh.StripCommandSecrets(cmd.Type, mesh.StripForward(cmd.Payload))
		if p.mesh == nil || !p.mesh.Enabled() || !p.mesh.CommandAllowed(cmd.Type) {
			handleErr = fmt.Errorf("not_allowed")
			result = map[string]string{"error": "not_allowed"}
		} else {
			result, handleErr = p.mesh.OfferCmd(dest, cmd.Type, inner)
		}
	} else {
		result, handleErr = commands.Handle(cmd.Type, cmd.Payload, deps)
	}
	status := "success"
	if handleErr != nil {
		status = "failed"
		p.log.Notef("ERROR", "command %s %s: %v", cmd.ID, cmd.Type, handleErr)
		result = commands.ErrorResult(result, handleErr)
	}
	p.reportResult(api, cmd.ID, resultID, status, result)
	reported = true
	if local && handleErr == nil && commands.IsPowerCommand(cmd.Type) {
		time.Sleep(2 * time.Second)
		if err := commands.PowerAction(cmd.Type); err != nil {
			p.log.Notef("ERROR", "power action %s: %v", cmd.Type, err)
		}
	}
	if local && handleErr == nil {
		if err := commands.ApplyDeferred(); err != nil {
			p.log.Notef("ERROR", "deferred command %s: %v", cmd.Type, err)
		}
	}
}

func (p *program) reportResult(api *client.Client, commandID, resultID, status string, result any) {
	if p.ws != nil && p.ws.Connected() {
		if err := p.ws.SendCommandResult(commandID, resultID, status, result, nil); err == nil {
			return
		} else {
			p.log.Notef("WARNING", "ws result: %v", err)
		}
	}
	if err := api.CommandResult(commandID, resultID, status, result); err != nil {
		p.log.Notef("WARNING", "result: %v", err)
	}
}

func (p *program) reportProgress(api *client.Client, commandID, resultID string, progress int) {
	if p.ws != nil && p.ws.Connected() {
		n := progress
		if err := p.ws.SendCommandResult(commandID, resultID, "running", map[string]any{"progress": n}, &n); err == nil {
			return
		}
	}
	api.CommandProgress(commandID, resultID, progress)
}

func (p *program) refreshEnrollmentSettings() {
	latest, err := config.Load()
	if err != nil || latest == nil {
		return
	}
	p.cfg.Lock()
	p.cfg.EnrollmentSecret = latest.EnrollmentSecret
	if strings.TrimSpace(latest.ServerURL) != "" {
		p.cfg.ServerURL = latest.ServerURL
	}
	p.cfg.Unlock()
}

func (p *program) enrollUntilReady(api **client.Client) error {
	id := p.cfg.DeviceID
	if id == "" {
		id = uuid.NewString()
	}
	backoff := time.Second
	const maxBackoff = 60 * time.Second
	for {
		p.refreshEnrollmentSettings()
		hostname, _ := os.Hostname()
		payload := map[string]any{
			"enrollmentSecret": p.cfg.EnrollmentSecret,
			"deviceId":         id,
			"hostname":         hostname,
			"platform":         runtime.GOOS,
			"arch":             runtime.GOARCH,
			"agentVersion":     Version,
		}
		if pub := p.e2ePub(); pub != "" {
			payload["e2ePub"] = pub
		}
		if p.cfg.DeviceKey != "" {
			payload["deviceKey"] = p.cfg.DeviceKey
		}
		deviceID, deviceKey, meshBundle, err := (*api).Enroll(payload)
		if err == nil {
			if deviceID != "" {
				p.cfg.DeviceID = deviceID
				id = deviceID
			} else if p.cfg.DeviceID == "" {
				p.cfg.DeviceID = id
			}
			if deviceKey != "" {
				p.cfg.DeviceKey = deviceKey
			}
			if p.mesh != nil {
				p.mesh.SetDeviceID(p.cfg.DeviceID)
				if meshBundle != nil {
					p.mesh.Install(meshBundleFromClient(meshBundle))
				}
			}
			if p.cfg.DeviceID != "" && p.cfg.DeviceKey != "" {
				if err := p.cfg.Save(); err != nil {
					p.log.Notef("WARNING", "save config: %v", err)
				}
				p.setLastError("")
				*api = client.New(p.cfg)
				notify.PostKind(notify.KindEnrolled)
				return nil
			}
			id = uuid.NewString()
			p.cfg.DeviceID = ""
			err = fmt.Errorf("enroll returned incomplete credentials; retrying with a new device id")
		}
		p.log.Notef("ERROR", "enroll failed: %v", err)
		p.setLastError(err.Error())
		if id, hostname, ok := client.DeviceExists(err); ok {
			p.log.Notef("ERROR", "this host is already enrolled as device %s (%s); reset enrollment in the dashboard instead of generating a new id", id, hostname)
			return err
		}
		if client.IsClientError(err) && strings.TrimSpace(p.cfg.EnrollmentSecret) != "" {
			p.log.Notef("ERROR", "enroll rejected (HTTP 4xx); not retrying")
			return err
		}
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
		t := time.NewTimer(backoff)
		select {
		case <-p.stopCh:
			t.Stop()
			return fmt.Errorf("stopped")
		case <-t.C:
		}
		if backoff < maxBackoff {
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

func (p *program) watchInterval() time.Duration {
	p.watchMu.Lock()
	interval := p.watchEvery
	p.watchMu.Unlock()
	if interval > 0 {
		return interval
	}
	if p.cfg.ScreenshotIntervalSec > 0 {
		d := time.Duration(p.cfg.ScreenshotIntervalSec) * time.Second
		if d < time.Second {
			return time.Second
		}
		return d
	}
	return 0
}

func (p *program) watchLoop() {
	var ticker *time.Ticker
	stopTicker := func() {
		if ticker != nil {
			ticker.Stop()
			ticker = nil
		}
	}
	defer stopTicker()
	for {
		interval := p.watchInterval()
		if interval <= 0 {
			stopTicker()
			select {
			case <-p.stopCh:
				return
			case <-p.watchWake:
			}
			continue
		}
		if ticker == nil {
			ticker = time.NewTicker(interval)
			p.captureWatchFrame()
			continue
		}
		select {
		case <-p.stopCh:
			return
		case <-p.watchWake:
			stopTicker()
		case <-ticker.C:
			p.captureWatchFrame()
		}
	}
}

func (p *program) captureWatchFrame() {
	if !p.cfg.EnableScreenshot {
		return
	}
	jpeg, err := screenshot.Capture()
	if err != nil {
		p.log.Notef("WARNING", "watch capture: %v", err)
		return
	}
	if int64(len(jpeg)) > client.MaxScreenshotBytes {
		return
	}
	if p.e2e != nil && p.e2e.Active() && p.ws != nil && p.ws.Connected() {
		env, err := p.e2e.Seal("screenshot", jpeg, "")
		if err == nil && p.ws.SendE2EEnvelope(env) == nil {
			return
		}
	}
	if p.ws != nil && p.ws.Connected() {
		if err := p.ws.SendScreenshot(jpeg); err == nil {
			return
		}
	}
	if p.api == nil {
		return
	}
	if err := p.api.UploadScreenshot(jpeg); err != nil {
		p.log.Notef("WARNING", "watch upload: %v", err)
	}
}

func (p *program) watchWSToasts() {
	up := false
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-p.stopCh:
			return
		case <-ticker.C:
			cur := p.ws != nil && p.ws.Connected()
			if cur == up {
				continue
			}
			if cur {
				notify.PostKind(notify.KindWSUp)
				p.flushMeshAudit(p.api)
			} else {
				notify.PostKind(notify.KindWSDown)
			}
			up = cur
		}
	}
}

func (p *program) e2ePub() string {
	if p.e2e == nil {
		return ""
	}
	return p.e2e.PubHex()
}

func (p *program) flushMeshAudit(api *client.Client) {
	if p.mesh == nil || api == nil {
		return
	}
	entries := p.mesh.FlushAudit()
	if len(entries) == 0 {
		return
	}
	if err := api.Logs(entries); err != nil {
		p.mesh.RestoreAudit(entries)
		p.log.Notef("WARNING", "mesh audit flush: %v", err)
	}
}

func meshBundleFromClient(b *client.MeshBundle) mesh.Bundle {
	if b == nil {
		return mesh.Bundle{}
	}
	return mesh.Bundle{
		Cert:           b.Cert,
		Key:            b.Key,
		CA:             b.CA,
		Serial:         b.Serial,
		NotAfter:       b.NotAfter,
		RevokedSerials: append([]string(nil), b.RevokedSerials...),
	}
}

func meshBundleFromWS(b *wsprotocol.MeshBundle) mesh.Bundle {
	if b == nil {
		return mesh.Bundle{}
	}
	return mesh.Bundle{
		Cert:           b.Cert,
		Key:            b.Key,
		CA:             b.CA,
		Serial:         b.Serial,
		NotAfter:       b.NotAfter,
		RevokedSerials: append([]string(nil), b.RevokedSerials...),
	}
}

func iceFromWS(in []wsprotocol.IceServer) []mesh.IceJSON {
	out := make([]mesh.IceJSON, 0, len(in))
	for _, s := range in {
		out = append(out, mesh.IceJSON{URLs: s.URLs, Username: s.Username, Credential: s.Credential})
	}
	return out
}

func hintsFromWS(in []wsprotocol.MeshPeerHint) []mesh.PeerHint {
	if in == nil {
		return nil
	}
	out := make([]mesh.PeerHint, 0, len(in))
	for _, p := range in {
		out = append(out, mesh.PeerHint{ID: p.ID, LanAddrs: append([]string(nil), p.LanAddrs...), IP: p.IP, LanPort: p.LanPort})
	}
	return out
}

func (p *program) refuseWebrtc() {
	if p.ws == nil {
		return
	}
	_ = p.ws.SendJSON(map[string]any{
		"type": wsprotocol.TypeWebrtcSignal,
		"payload": map[string]any{
			"kind":   "hangup",
			"error":  "webrtc_disabled",
			"reason": "webrtc_disabled",
		},
	})
}

func (p *program) sendDesktopSignal(payload desktop.SignalPayload) {
	if p.ws == nil {
		return
	}
	if !p.cfg.EnableWebrtc && payload.Kind != "hangup" {
		return
	}
	if p.e2e != nil && p.e2e.Active() {
		raw, err := json.Marshal(payload)
		if err == nil {
			env, err := p.e2e.Seal("sdp", raw, "")
			if err == nil {
				_ = p.ws.SendE2EEnvelope(env)
				return
			}
		}
	}
	_ = p.ws.SendJSON(map[string]any{"type": "webrtc_signal", "payload": payload})
}

func (p *program) onE2E(payload json.RawMessage) {
	if p.e2e == nil {
		return
	}
	var env e2e.DataEnvelope
	if err := json.Unmarshal(payload, &env); err != nil {
		return
	}
	switch env.Action {
	case "offer":
		if err := p.e2e.AcceptOffer(env.SessionID, env.OperatorPub); err != nil {
			p.log.Notef("WARNING", "e2e offer: %v", err)
			return
		}
		_ = p.ws.SendE2EEnvelope(map[string]any{
			"action":    "answer",
			"sessionId": env.SessionID,
			"agentPub":  p.e2e.PubHex(),
		})
	case "close":
		p.e2e.Close()
	case "data":
		plain, err := p.e2e.Open(env.Nonce, env.Ciphertext, env.AAD)
		if err != nil {
			return
		}
		switch env.Kind {
		case "sdp":
			if !p.cfg.EnableWebrtc {
				p.refuseWebrtc()
				return
			}
			if p.desk != nil {
				p.desk.Handle(plain)
			}
		case "file_chunk":
			if p.xfer != nil {
				resolve := func(path string) (string, error) {
					p.sandboxMu.Lock()
					sb := p.sandbox
					p.sandboxMu.Unlock()
					if sb == nil {
						return "", fmt.Errorf("no sandbox")
					}
					return sb.Resolve(path)
				}
				if err := p.xfer.ReceiveE2EChunk(plain, resolve); err != nil {
					p.log.Notef("WARNING", "e2e file chunk: %v", err)
				}
			}
		}
	}
}

func (p *program) scheduleLoop() {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-p.stopCh:
			return
		case <-ticker.C:
			when := strings.TrimSpace(p.cfg.AutoRestartTime)
			if when == "" {
				continue
			}
			now := time.Now()
			if now.Format("15:04") != when {
				continue
			}
			day := now.Format("2006-01-02")
			if p.lastRestart == day {
				continue
			}
			p.lastRestart = day
			p.log.Notef("INFO", "scheduled restart at %s, delaying 60s", when)
			t := time.NewTimer(60 * time.Second)
			select {
			case <-p.stopCh:
				t.Stop()
				return
			case <-t.C:
			}
			if err := commands.RestartHost(); err != nil {
				p.log.Notef("ERROR", "scheduled restart failed: %v", err)
			}
		}
	}
}

func statusTokenPath(dataDir string) string {
	return filepath.Join(dataDir, "status.token")
}

func ensureStatusToken(dataDir string) string {
	path := statusTokenPath(dataDir)
	if raw, err := os.ReadFile(path); err == nil {
		if tok := strings.TrimSpace(string(raw)); tok != "" {
			return tok
		}
	}
	tok := uuid.NewString()
	if err := os.WriteFile(path, []byte(tok+"\n"), 0o600); err != nil {
		return ""
	}
	return tok
}

func (p *program) serveStatus() {
	token := ensureStatusToken(p.cfg.DataDir)
	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-Status-Token")
		if token != "" && got != "" && got != token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		watchMs := p.watchInterval().Milliseconds()
		endpoint := ""
		if p.api != nil {
			endpoint = p.api.ActiveEndpoint()
		}
		p.hbMu.Lock()
		hb := p.lastHeartbeat
		p.hbMu.Unlock()
		var lastHB any
		if !hb.IsZero() {
			lastHB = hb.UTC().Format(time.RFC3339)
		}
		wsConnected := p.ws != nil && p.ws.Connected()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deviceId":         p.cfg.DeviceID,
			"version":          Version,
			"serverUrl":        p.cfg.ServerURL,
			"activeEndpoint":   endpoint,
			"watchIntervalMs":  watchMs,
			"lastHeartbeat":    lastHB,
			"inFlightCommands": p.inFlight.Load(),
			"wsConnected":      wsConnected,
			"enrolled":         p.cfg.Enrolled(),
			"lastError":        p.getLastError(),
		})
	})
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p.cfg.StatusPort))
	if err != nil {
		msg := fmt.Sprintf("status listen 127.0.0.1:%d: %v", p.cfg.StatusPort, err)
		p.log.Notef("ERROR", "%s", msg)
		p.setLastError(msg)
		return
	}
	if err := http.Serve(ln, mux); err != nil && p.log != nil {
		p.log.Notef("ERROR", "status server: %v", err)
		p.setLastError("status server: " + err.Error())
	}
}

func printVersionAndExit() {
	fmt.Println(Version)
}

func parseTrayOptions(cfg *config.Config) tray.Options {
	opts := tray.Options{Version: Version, StatusPort: cfg.StatusPort, DataDir: cfg.DataDir}
	args := os.Args[2:]
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--status-port" && i+1 < len(args):
			i++
			if n, err := strconv.Atoi(args[i]); err == nil {
				opts.StatusPort = n
			}
		case strings.HasPrefix(a, "--status-port="):
			if n, err := strconv.Atoi(strings.TrimPrefix(a, "--status-port=")); err == nil {
				opts.StatusPort = n
			}
		case a == "--data-dir" && i+1 < len(args):
			i++
			opts.DataDir = args[i]
		case strings.HasPrefix(a, "--data-dir="):
			opts.DataDir = strings.TrimPrefix(a, "--data-dir=")
		}
	}
	return opts
}

func main() {
	ensureConsoleForCLI()
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "--version":
			printVersionAndExit()
			return
		case "capture-helper":
			desktop.RegisterCaptureHelperH264()
			if err := capture.RunHelper(capture.ParsePipeArg(os.Args[2:])); err != nil {
				log.Fatal(err)
			}
			return
		case "finish-update":
			if len(os.Args) < 4 {
				log.Fatal("finish-update requires exe and pending paths")
			}
			exe := os.Args[2]
			pending := os.Args[3]
			bak := exe + ".bak"
			if len(os.Args) > 4 && os.Args[4] != "" {
				bak = os.Args[4]
			}
			if err := updater.FinishUpdate(exe, pending, bak); err != nil {
				log.Fatal(err)
			}
			return
		}
	}
	if len(os.Args) > 2 && os.Args[1] == "run" && os.Args[2] == "--version" {
		printVersionAndExit()
		return
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	if len(os.Args) > 1 && os.Args[1] == "tray" {
		tray.Run(parseTrayOptions(cfg))
		return
	}
	lg := logger.Setup(cfg.DataDir)
	lg.Notef("INFO", "config path: %s", cfg.Path())
	if strings.TrimSpace(cfg.EnrollmentSecret) == "" && !cfg.Enrolled() {
		lg.Note("WARNING", "enrollment_secret is empty and this agent is not enrolled; continuing")
		for _, p := range cfg.Tried() {
			lg.Notef("INFO", "tried config: %s", p)
		}
	}
	prg := &program{cfg: cfg, log: lg}

	exe, _ := os.Executable()
	svcConfig := winsvc.AgentServiceConfig(exe)
	s, err := service.New(prg, svcConfig)
	if err != nil {
		log.Fatal(err)
	}
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "install", "uninstall", "start", "stop", "restart":
			if err := winsvc.HandleControl(os.Args[1], exe); err != nil {
				log.Fatal(err)
			}
			return
		case "self-install":
			if err := winsvc.SelfInstall(); err != nil {
				log.Println(err)
				winsvc.Alert("Install as service", err.Error())
			}
			tray.Run(tray.Options{Version: Version, StatusPort: cfg.StatusPort, DataDir: cfg.DataDir})
			return
		case "run", "console":
			ensureConsoleForDebug()
			if err := prg.Start(s); err != nil {
				log.Fatal(err)
			}
			ch := make(chan os.Signal, 1)
			signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
			<-ch
			_ = prg.Stop(s)
			return
		}
	}
	if maybeWindowsInteractive(cfg) {
		return
	}
	if err := s.Run(); err != nil {
		log.Fatal(err)
	}
}
