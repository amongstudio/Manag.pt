//go:build linux

package plugin

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func stageForExec(runtimeName string, data []byte) (artifact, error) {
	if runtimeName == "go_source" {
		return stageTemp(data, ".go", false)
	}
	executable := runtimeName == "binary"
	f, err := memfdCreate("pc-plugin", data, executable)
	if err != nil {
		return stageTemp(data, extFor(runtimeName), executable)
	}
	path := fmt.Sprintf("/proc/%d/fd/%d", os.Getpid(), f.Fd())
	return artifact{
		Path: path,
		Cleanup: func() {
			_ = f.Close()
		},
	}, nil
}

func memfdCreate(name string, data []byte, executable bool) (*os.File, error) {
	fd, err := unix.MemfdCreate(name, unix.MFD_CLOEXEC)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return nil, err
	}
	if _, err := f.Seek(0, 0); err != nil {
		_ = f.Close()
		return nil, err
	}
	if executable {
		if err := unix.Fchmod(int(f.Fd()), 0o700); err != nil {
			_ = f.Close()
			return nil, err
		}
	}
	return f, nil
}
