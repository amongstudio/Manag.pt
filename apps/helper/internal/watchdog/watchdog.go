package watchdog

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pc-manager/helper/internal/agentctl"
	"github.com/pc-manager/helper/internal/config"
	"github.com/pc-manager/helper/internal/update"
)

type Options struct {
	StatusURL           string
	FailThreshold       int
	ProbeInterval       time.Duration
	Backoff             time.Duration
	MaxBackoff          time.Duration
	StartupGrace        time.Duration
	AgentExe            string
	UpdateFile          string
	UpdateSHA256        string
	UpdateSignature     string
	UpdateSigningSecret string
	DataDir             string
	Controller          agentctl.Controller
	Probe               func(ctx context.Context, url string) error
	Log                 *log.Logger
	Now                 func() time.Time
}

type Watchdog struct {
	mu          sync.Mutex
	opt         Options
	failures    int
	healthy     int
	backoff     time.Duration
	lastStart   time.Time
	nextAction  time.Time
	lastWarn    time.Time
	updateTries int
	httpClient  *http.Client
}

func FromConfig(cfg config.Config, ctl agentctl.Controller, lg *log.Logger) *Watchdog {
	return New(Options{
		StatusURL:           cfg.StatusURL(),
		FailThreshold:       cfg.FailThreshold,
		ProbeInterval:       time.Duration(cfg.ProbeIntervalSec) * time.Second,
		Backoff:             time.Duration(cfg.BackoffSec) * time.Second,
		MaxBackoff:          time.Duration(cfg.MaxBackoffSec) * time.Second,
		StartupGrace:        time.Duration(cfg.StartupGraceSec) * time.Second,
		AgentExe:            cfg.AgentExe,
		UpdateFile:          cfg.UpdateFile,
		UpdateSHA256:        cfg.UpdateSHA256,
		UpdateSignature:     cfg.UpdateSignature,
		UpdateSigningSecret: cfg.UpdateSigningSecret,
		DataDir:             cfg.DataDir,
		Controller:          ctl,
		Log:                 lg,
	})
}

func New(opt Options) *Watchdog {
	if opt.FailThreshold <= 0 {
		opt.FailThreshold = 3
	}
	if opt.ProbeInterval <= 0 {
		opt.ProbeInterval = 45 * time.Second
	}
	if opt.Backoff <= 0 {
		opt.Backoff = 30 * time.Second
	}
	if opt.MaxBackoff <= 0 {
		opt.MaxBackoff = 5 * time.Minute
	}
	if opt.Log == nil {
		opt.Log = log.New(os.Stderr, "", log.LstdFlags)
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	w := &Watchdog{
		opt:     opt,
		backoff: opt.Backoff,
		httpClient: &http.Client{
			Timeout: 3 * time.Second,
			Transport: &http.Transport{
				Proxy: func(*http.Request) (*url.URL, error) { return nil, nil },
				DialContext: (&net.Dialer{
					Timeout: 2 * time.Second,
				}).DialContext,
				DisableKeepAlives:   false,
				MaxIdleConns:        1,
				MaxIdleConnsPerHost: 1,
				IdleConnTimeout:     90 * time.Second,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
	if opt.Probe == nil {
		w.opt.Probe = w.defaultProbe
	}
	return w
}

func (w *Watchdog) statusToken() string {
	dir := w.opt.DataDir
	if dir == "" && w.opt.AgentExe != "" {
		dir = filepath.Dir(w.opt.AgentExe)
	}
	if dir == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(dir, "status.token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func (w *Watchdog) defaultProbe(ctx context.Context, statusURL string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, statusURL, nil)
	if err != nil {
		return err
	}
	if tok := w.statusToken(); tok != "" {
		req.Header.Set("X-Status-Token", tok)
	}
	res, err := w.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", res.StatusCode)
	}
	return nil
}

func (w *Watchdog) Run(ctx context.Context) error {
	w.Tick(ctx)
	ticker := time.NewTicker(w.opt.ProbeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			w.Tick(ctx)
		}
	}
}

func (w *Watchdog) Tick(ctx context.Context) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.maybeApplyLocalUpdateLocked()
	if w.hasStagedBinary() {
		// Do not Start the old binary while a pending replace is on disk.
		return
	}

	st, err := w.opt.Controller.Status()
	if err != nil || (st != agentctl.StatusRunning && st != agentctl.StatusStartPending) {
		if err != nil {
			w.opt.Log.Printf("agent service status: %v", err)
		} else if st == agentctl.StatusStartPending {
			w.opt.Log.Printf("agent service start pending; waiting")
			return
		} else {
			w.opt.Log.Printf("agent service not running; starting")
		}
		now := w.opt.Now()
		if !w.nextAction.IsZero() && now.Before(w.nextAction) {
			return
		}
		if startErr := w.opt.Controller.Start(); startErr != nil {
			w.opt.Log.Printf("start agent: %v", startErr)
			w.scheduleBackoffLocked()
			return
		}
		w.lastStart = now
		w.nextAction = now.Add(w.backoff)
		return
	}

	if w.inGraceLocked() {
		return
	}

	if err := w.opt.Probe(ctx, w.opt.StatusURL); err != nil {
		w.healthy = 0
		w.failures++
		w.opt.Log.Printf("status probe failed (%d/%d): %v", w.failures, w.opt.FailThreshold, err)
		if w.failures >= w.opt.FailThreshold {
			w.restartAgentLocked()
		}
		return
	}
	w.failures = 0
	w.healthy++
	if w.healthy >= 3 {
		w.backoff = w.opt.Backoff
		w.healthy = 0
	}
}

func (w *Watchdog) inGraceLocked() bool {
	if w.lastStart.IsZero() || w.opt.StartupGrace <= 0 {
		return false
	}
	return w.opt.Now().Sub(w.lastStart) < w.opt.StartupGrace
}

func (w *Watchdog) scheduleBackoffLocked() {
	now := w.opt.Now()
	w.nextAction = now.Add(w.backoff)
	next := w.backoff * 2
	if next > w.opt.MaxBackoff {
		next = w.opt.MaxBackoff
	}
	w.backoff = next
}

func (w *Watchdog) restartAgentLocked() {
	now := w.opt.Now()
	if !w.nextAction.IsZero() && now.Before(w.nextAction) {
		return
	}
	w.opt.Log.Printf("restarting agent service after %d failed probes", w.failures)
	if err := w.opt.Controller.Restart(); err != nil {
		w.opt.Log.Printf("restart agent: %v", err)
		return
	}
	w.lastStart = now
	w.scheduleBackoffLocked()
}

func (w *Watchdog) stagedBinary() string {
	if w.opt.AgentExe == "" {
		return ""
	}
	p := w.opt.AgentExe + ".new"
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return ""
}

func (w *Watchdog) hasStagedBinary() bool {
	return w.stagedBinary() != ""
}

func (w *Watchdog) ApplyPendingUpdate() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.maybeApplyLocalUpdateLocked()
}

func (w *Watchdog) maybeApplyLocalUpdateLocked() {
	if staged := w.stagedBinary(); staged != "" {
		w.applyStagedLocked(staged)
		return
	}
	path := w.opt.UpdateFile
	if path == "" {
		return
	}
	if _, err := os.Stat(path); err != nil {
		return
	}
	if w.updateTries >= 3 {
		w.warnf("local update %s rejected after 3 failed attempts", path)
		return
	}
	if w.opt.UpdateSigningSecret == "" || w.opt.UpdateSignature == "" || w.opt.UpdateSHA256 == "" {
		w.warnf("local update %s ignored: update_sha256, update_signature, and update_signing_secret are all required", path)
		return
	}
	if err := update.VerifySHA256(path, w.opt.UpdateSHA256); err != nil {
		w.updateTries++
		w.warnf("local update checksum: %v", err)
		return
	}
	if err := update.VerifySignature(w.opt.UpdateSHA256, w.opt.UpdateSignature, w.opt.UpdateSigningSecret); err != nil {
		w.updateTries++
		w.warnf("local update signature: %v", err)
		_ = os.Rename(path, path+".failed")
		return
	}
	w.applyStagedLocked(path)
}

func (w *Watchdog) applyStagedLocked(path string) {
	if w.updateTries >= 3 {
		w.warnf("local update %s rejected after 3 failed attempts", path)
		return
	}
	if w.opt.AgentExe == "" {
		w.warnf("local update %s ignored: agent_exe is not set", path)
		return
	}
	w.opt.Log.Printf("applying local agent update from %s", path)
	if err := w.opt.Controller.Stop(); err != nil {
		w.opt.Log.Printf("stop agent for update: %v", err)
		return
	}
	var err error
	if w.opt.UpdateSHA256 != "" && path == w.opt.UpdateFile {
		err = update.Apply(w.opt.AgentExe, path, w.opt.UpdateSHA256)
	} else {
		err = update.Replace(w.opt.AgentExe, path)
	}
	if err != nil {
		w.updateTries++
		w.opt.Log.Printf("apply update: %v", err)
		if startErr := w.opt.Controller.Start(); startErr != nil {
			w.opt.Log.Printf("start agent after failed update: %v", startErr)
		}
		return
	}
	if err := w.opt.Controller.Start(); err != nil {
		w.opt.Log.Printf("start agent after update: %v", err)
		return
	}
	w.updateTries = 0
	w.lastStart = w.opt.Now()
	w.opt.Log.Printf("agent binary replaced and service started")
}

func (w *Watchdog) warnf(format string, args ...any) {
	now := w.opt.Now()
	if !w.lastWarn.IsZero() && now.Sub(w.lastWarn) < w.opt.Backoff {
		return
	}
	w.lastWarn = now
	w.opt.Log.Printf(format, args...)
}
