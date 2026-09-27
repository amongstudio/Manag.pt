//go:build windows

package capture

import (
	"io"

	"golang.org/x/sys/windows"
)

type pipeIO struct {
	h windows.Handle
}

func (p *pipeIO) Read(b []byte) (int, error) {
	if p == nil || p.h == 0 {
		return 0, io.EOF
	}
	var n uint32
	err := windows.ReadFile(p.h, b, &n, nil)
	if n > 0 {
		return int(n), nil
	}
	if err != nil {
		return 0, err
	}
	return 0, io.EOF
}

func (p *pipeIO) Write(b []byte) (int, error) {
	if p == nil || p.h == 0 {
		return 0, io.ErrClosedPipe
	}
	var n uint32
	err := windows.WriteFile(p.h, b, &n, nil)
	return int(n), err
}
