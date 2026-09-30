//go:build !windows

package filemanager

import (
	"os"
	"path/filepath"
)

func extraHomeDir() string { return "" }

func platformRoots() []string {
	if filepath.Separator == '/' {
		return []string{"/"}
	}
	dir, err := os.Getwd()
	if err != nil {
		return nil
	}
	return []string{filepath.VolumeName(dir) + string(filepath.Separator)}
}
