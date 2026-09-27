//go:build windows

package main

import (
	"github.com/kardianos/service"
	"github.com/pc-manager/agent/internal/config"
	"github.com/pc-manager/agent/internal/tray"
	"github.com/pc-manager/agent/internal/winsvc"
)

func maybeWindowsInteractive(cfg *config.Config) bool {
	interactive := service.Interactive()
	if !interactive {
		return false
	}
	if !winsvc.AgentInstalled() {
		if !winsvc.IsElevated() {
			if err := winsvc.RelaunchElevated("self-install"); err != nil {
				tray.Run(tray.Options{Version: Version, StatusPort: cfg.StatusPort, DataDir: cfg.DataDir})
			}
			return true
		}
		if err := winsvc.SelfInstall(); err != nil {
			winsvc.Alert("Install as service", err.Error())
		}
	}
	tray.Run(tray.Options{Version: Version, StatusPort: cfg.StatusPort, DataDir: cfg.DataDir})
	return true
}
