//go:build windows

package netwin

import (
	"context"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
)

const createNoWindow = 0x08000000

func system32(name string) string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32", name)
}

func runHidden(timeout time.Duration, name string, args ...string) (string, error) {
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	out, err := cmd.CombinedOutput()
	return decodeConsole(out), err
}

func runCmdEnglish(timeout time.Duration, exe string, args ...string) (string, error) {
	var b strings.Builder
	b.WriteString("chcp 437>nul & ")
	b.WriteByte('"')
	b.WriteString(exe)
	b.WriteByte('"')
	for _, a := range args {
		b.WriteByte(' ')
		b.WriteByte('"')
		b.WriteString(strings.ReplaceAll(a, `"`, `""`))
		b.WriteByte('"')
	}
	return runHidden(timeout, system32("cmd.exe"), "/d", "/c", b.String())
}

func decodeConsole(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	if len(b) >= 2 && b[0] == 0xFF && b[1] == 0xFE {
		return utf16LEToString(b[2:])
	}
	if len(b) >= 2 && b[0] == 0xFE && b[1] == 0xFF {
		return utf16BEToString(b[2:])
	}
	if looksUTF16LE(b) {
		return utf16LEToString(b)
	}
	return strings.TrimPrefix(string(b), "\ufeff")
}

func looksUTF16LE(b []byte) bool {
	n := len(b)
	if n < 8 {
		return false
	}
	if n > 64 {
		n = 64
	}
	nuls := 0
	for i := 1; i < n; i += 2 {
		if b[i] == 0 {
			nuls++
		}
	}
	return nuls >= n/4
}

func utf16LEToString(b []byte) string {
	if len(b)%2 == 1 {
		b = b[:len(b)-1]
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(b[i*2:])
	}
	return string(utf16.Decode(u))
}

func utf16BEToString(b []byte) string {
	if len(b)%2 == 1 {
		b = b[:len(b)-1]
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = binary.BigEndian.Uint16(b[i*2:])
	}
	return string(utf16.Decode(u))
}
