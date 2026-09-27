//go:build !windows

package notify

func show(Message) error { return nil }

func ensureTray() {}
