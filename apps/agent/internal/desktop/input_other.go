//go:build !windows && !lite

package desktop

func inputSupported() bool { return false }

func clipSupported() bool { return false }

func clipboardWatchSupported() bool { return false }

func clipboardWatchMode() string { return "off" }

func clipboardSequence() uint32 { return 0 }

func inject(_ inputEvent, _ int) {}

func releaseHeldInput() {}

func setClipboard(_ string) error { return nil }

func getClipboard() (string, error) { return "", nil }
