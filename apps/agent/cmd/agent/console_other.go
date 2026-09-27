//go:build !windows

package main

func ensureConsoleForCLI()   {}
func ensureConsoleForDebug() {}
func allocConsole()          {}
