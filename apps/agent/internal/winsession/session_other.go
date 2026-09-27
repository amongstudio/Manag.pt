//go:build !windows

package winsession

func InSession0() bool { return false }

func HasConsoleUser() bool { return false }

func ConsoleUserProfile() string { return "" }
