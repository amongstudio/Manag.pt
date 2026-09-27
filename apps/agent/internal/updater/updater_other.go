//go:build !windows

package updater

import "fmt"

func applyWindows(exe, newPath, bak string) error {
	return fmt.Errorf("windows update is not supported on this OS")
}

func FinishUpdate(exe, pending, bak string) error {
	return fmt.Errorf("finish-update is Windows-only")
}
