//go:build windows

package filemanager

import "github.com/pc-manager/agent/internal/winsession"

func extraHomeDir() string {
	return winsession.ConsoleUserProfile()
}
