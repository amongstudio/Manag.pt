//go:build !windows

package winsvc

func ApplyRecovery(serviceName string) error { return nil }

func AgentInstalled() bool { return false }

func HelperInstalled() bool { return false }

func AgentRunning() bool { return false }

func SelfInstall() error { return nil }

func StopAgent() error { return nil }

func StartHelper() error { return nil }

func IsElevated() bool { return true }

func RelaunchElevated(arg string) error { return nil }

func Confirm(title, body string) bool { return false }

func Alert(title, body string) {}
