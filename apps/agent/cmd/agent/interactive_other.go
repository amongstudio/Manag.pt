//go:build !windows

package main

import "github.com/pc-manager/agent/internal/config"

func maybeWindowsInteractive(cfg *config.Config) bool { return false }
