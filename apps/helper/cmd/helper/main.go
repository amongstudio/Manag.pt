package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/kardianos/service"
	"github.com/pc-manager/helper/internal/agentctl"
	"github.com/pc-manager/helper/internal/config"
	"github.com/pc-manager/helper/internal/recovery"
	"github.com/pc-manager/helper/internal/watchdog"
)

var Version = "3.4.0"

type program struct {
	cfg    config.Config
	log    *log.Logger
	closer io.Closer
	cancel context.CancelFunc
	done   chan struct{}
}

func waitStop(done <-chan struct{}, timeout time.Duration) error {
	if done == nil {
		return nil
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return nil
	case <-timer.C:
		return fmt.Errorf("helper stop timed out")
	}
}

func helperServiceName() string {
	if runtime.GOOS == "windows" {
		return "PCManagerHelper"
	}
	return "pc-manager-helper"
}

func (p *program) Start(s service.Service) error {
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.done = make(chan struct{})
	go func() {
		defer close(p.done)
		p.run(ctx)
	}()
	return nil
}

func (p *program) Stop(s service.Service) error {
	if p.cancel != nil {
		p.cancel()
	}
	if err := waitStop(p.done, 5*time.Second); err != nil && p.log != nil {
		p.log.Printf("%v", err)
	}
	if p.closer != nil {
		_ = p.closer.Close()
		p.closer = nil
	}
	return nil
}

func (p *program) run(ctx context.Context) {
	ctl := agentctl.New(p.cfg.AgentServiceName)
	wd := watchdog.FromConfig(p.cfg, ctl, p.log)
	p.log.Printf("helper %s watching %s via %s", Version, p.cfg.AgentServiceName, p.cfg.StatusURL())
	_ = wd.Run(ctx)
}

func printVersionAndExit() {
	fmt.Println(Version)
}

func setupLog(dataDir string) (*log.Logger, io.Closer) {
	w := io.Writer(os.Stderr)
	var closer io.Closer
	if dataDir != "" {
		_ = os.MkdirAll(dataDir, 0o755)
		f, err := os.OpenFile(filepath.Join(dataDir, "helper.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err == nil {
			w = io.MultiWriter(os.Stderr, f)
			closer = f
		}
	}
	return log.New(w, "", log.LstdFlags), closer
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "--version":
			printVersionAndExit()
			return
		case "apply-update":
			cfg, err := config.Load()
			if err != nil {
				log.Fatal(err)
			}
			lg, closer := setupLog(cfg.DataDir)
			if closer != nil {
				defer closer.Close()
			}
			ctl := agentctl.New(cfg.AgentServiceName)
			wd := watchdog.FromConfig(cfg, ctl, lg)
			wd.ApplyPendingUpdate()
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
	lg, closer := setupLog(cfg.DataDir)
	prg := &program{cfg: cfg, log: lg, closer: closer}

	svcConfig := &service.Config{
		Name:        helperServiceName(),
		DisplayName: "Mnag.pt Helper",
		Description: "Watchdog that keeps the Mnag.pt Agent service running",
		UserName:    "", // Windows: empty → LocalSystem
		Option: service.KeyValue{
			"OnFailure":              "restart",
			"OnFailureDelayDuration": "5s",
			"OnFailureResetPeriod":   86400,
		},
	}
	s, err := service.New(prg, svcConfig)
	if err != nil {
		log.Fatal(err)
	}
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "install", "uninstall", "start", "stop", "restart":
			if err := service.Control(s, os.Args[1]); err != nil {
				log.Fatal(err)
			}
			if os.Args[1] == "install" {
				if err := recovery.Apply(helperServiceName()); err != nil {
					lg.Printf("warning: scm recovery: %v", err)
				}
			}
			return
		case "run":
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
	if err := s.Run(); err != nil {
		log.Fatal(err)
	}
}
