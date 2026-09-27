package watchdog

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pc-manager/helper/internal/agentctl"
)

type fakeCtl struct {
	st        agentctl.Status
	statusErr error
	starts    int
	restarts  int
	stops     int
	startErr  error
	stopErr   error
}

func (f *fakeCtl) Status() (agentctl.Status, error) { return f.st, f.statusErr }
func (f *fakeCtl) Start() error {
	f.starts++
	if f.startErr != nil {
		return f.startErr
	}
	f.st = agentctl.StatusRunning
	return nil
}
func (f *fakeCtl) Stop() error {
	f.stops++
	if f.stopErr != nil {
		return f.stopErr
	}
	f.st = agentctl.StatusStopped
	return nil
}
func (f *fakeCtl) Restart() error {
	f.restarts++
	f.st = agentctl.StatusRunning
	return nil
}

func TestStartHonorsBackoff(t *testing.T) {
	ctl := &fakeCtl{st: agentctl.StatusStopped}
	now := time.Now()
	w := New(Options{
		StatusURL:     "http://127.0.0.1:9/status",
		FailThreshold: 3,
		StartupGrace:  0,
		Controller:    ctl,
		Log:           log.New(io.Discard, "", 0),
		Now:           func() time.Time { return now },
		Probe:         func(context.Context, string) error { return errors.New("unused") },
	})
	w.nextAction = now.Add(time.Minute)
	w.Tick(context.Background())
	if ctl.starts != 0 {
		t.Fatalf("starts=%d during backoff", ctl.starts)
	}
}

func TestStartsWhenNotRunning(t *testing.T) {
	ctl := &fakeCtl{st: agentctl.StatusStopped}
	w := New(Options{
		StatusURL:     "http://127.0.0.1:9/status",
		FailThreshold: 3,
		StartupGrace:  0,
		Controller:    ctl,
		Log:           log.New(io.Discard, "", 0),
		Probe:         func(context.Context, string) error { return errors.New("unused") },
	})
	w.Tick(context.Background())
	if ctl.starts != 1 {
		t.Fatalf("starts=%d", ctl.starts)
	}
}

func TestRestartAfterConsecutiveProbeFailures(t *testing.T) {
	ctl := &fakeCtl{st: agentctl.StatusRunning}
	w := New(Options{
		StatusURL:     "http://127.0.0.1:9/status",
		FailThreshold: 3,
		StartupGrace:  0,
		Controller:    ctl,
		Log:           log.New(io.Discard, "", 0),
		Probe:         func(context.Context, string) error { return errors.New("down") },
	})
	for i := 0; i < 3; i++ {
		w.Tick(context.Background())
	}
	if ctl.restarts != 1 {
		t.Fatalf("restarts=%d failures=%d", ctl.restarts, w.failures)
	}
}

func TestHealthyProbeResetsFailures(t *testing.T) {
	ctl := &fakeCtl{st: agentctl.StatusRunning}
	fail := true
	w := New(Options{
		FailThreshold: 3,
		StartupGrace:  0,
		Controller:    ctl,
		Log:           log.New(io.Discard, "", 0),
		Probe: func(context.Context, string) error {
			if fail {
				return errors.New("down")
			}
			return nil
		},
	})
	w.Tick(context.Background())
	w.Tick(context.Background())
	fail = false
	w.Tick(context.Background())
	if w.failures != 0 {
		t.Fatalf("failures=%d", w.failures)
	}
	if ctl.restarts != 0 {
		t.Fatalf("restarts=%d", ctl.restarts)
	}
}

func TestDefaultProbeHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/status" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"version":"3.2.1"}`))
	}))
	defer srv.Close()

	ctl := &fakeCtl{st: agentctl.StatusRunning}
	w := New(Options{
		StatusURL:     srv.URL + "/status",
		FailThreshold: 2,
		StartupGrace:  0,
		Controller:    ctl,
		Log:           log.New(io.Discard, "", 0),
	})
	w.Tick(context.Background())
	if w.failures != 0 {
		t.Fatalf("healthy probe counted as failure: %d", w.failures)
	}

	srv.Close()
	w.Tick(context.Background())
	w.Tick(context.Background())
	if ctl.restarts != 1 {
		t.Fatalf("restarts=%d", ctl.restarts)
	}
}

func TestGraceSkipsProbe(t *testing.T) {
	ctl := &fakeCtl{st: agentctl.StatusRunning}
	now := time.Now()
	w := New(Options{
		FailThreshold: 1,
		StartupGrace:  time.Minute,
		Controller:    ctl,
		Log:           log.New(io.Discard, "", 0),
		Now:           func() time.Time { return now },
		Probe:         func(context.Context, string) error { return errors.New("down") },
	})
	w.lastStart = now
	w.Tick(context.Background())
	if ctl.restarts != 0 {
		t.Fatal("restarted during grace")
	}
}

func TestDoesNotStartOldBinaryWhileStaged(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "agent.bin")
	if err := os.WriteFile(exe, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe+".new", []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctl := &fakeCtl{st: agentctl.StatusStopped, stopErr: errors.New("busy")}
	w := New(Options{
		AgentExe:      exe,
		Controller:    ctl,
		Log:           log.New(io.Discard, "", 0),
		FailThreshold: 3,
		StartupGrace:  0,
		Probe:         func(context.Context, string) error { return nil },
	})
	w.Tick(context.Background())
	if ctl.starts != 0 {
		t.Fatalf("started old binary while staged update present: starts=%d", ctl.starts)
	}
}
