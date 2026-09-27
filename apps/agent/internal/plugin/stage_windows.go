//go:build windows

package plugin

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
)

func stageForExec(runtimeName string, data []byte) (artifact, error) {
	ext := extFor(runtimeName)
	dir := os.TempDir()
	path := filepath.Join(dir, fmt.Sprintf("pc-plugin-%d-%d%s", os.Getpid(), time.Now().UnixNano(), ext))
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return artifact{}, err
	}
	access := uint32(windows.GENERIC_READ | windows.GENERIC_WRITE)
	share := uint32(windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE)
	attrs := uint32(windows.FILE_ATTRIBUTE_TEMPORARY | windows.FILE_FLAG_DELETE_ON_CLOSE)
	h, err := windows.CreateFile(name, access, share, nil, windows.CREATE_ALWAYS, attrs, 0)
	if err != nil {
		return stageTemp(data, ext, runtimeName == "binary")
	}
	f := os.NewFile(uintptr(h), path)
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return artifact{}, err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return artifact{}, err
	}
	return artifact{
		Path: path,
		Cleanup: func() {
			_ = f.Close()
		},
	}, nil
}
