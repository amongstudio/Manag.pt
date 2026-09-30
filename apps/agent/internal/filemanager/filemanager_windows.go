//go:build windows

package filemanager

import (
	"fmt"
	"os"

	"github.com/pc-manager/agent/internal/winsession"
)

func extraHomeDir() string {
	return winsession.ConsoleUserProfile()
}

func platformRoots() []string {
	roots := make([]string, 0, 8)
	for drive := 'A'; drive <= 'Z'; drive++ {
		root := fmt.Sprintf("%c:\\", drive)
		if _, err := os.Stat(root); err == nil {
			roots = append(roots, root)
		}
	}
	return roots
}
