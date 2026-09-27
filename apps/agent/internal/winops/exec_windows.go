//go:build windows

package winops

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/pc-manager/agent/internal/winsession"
	"golang.org/x/sys/windows"
)

const createNoWindow = 0x08000000

func system32(name string) string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32", name)
}

func powershellExe() string {
	return system32(`WindowsPowerShell\v1.0\powershell.exe`)
}

func runHidden(timeout time.Duration, name string, args ...string) (string, error) {
	return runHiddenEnv(timeout, nil, name, args...)
}

// runHiddenInSession runs a console program hidden and returns combined stdout/stderr.
// When the agent is in Session 0 (Windows service), the process is launched in the
// active console user's session so Defender cmdlets and similar APIs work.
func runHiddenInSession(timeout time.Duration, name string, args ...string) (string, error) {
	if !winsession.InSession0() {
		return runHidden(timeout, name, args...)
	}
	if !winsession.HasConsoleUser() {
		return "", ErrNoSession
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	var sa windows.SecurityAttributes
	sa.Length = uint32(unsafe.Sizeof(sa))
	sa.InheritHandle = 1
	var outR, outW windows.Handle
	if err := windows.CreatePipe(&outR, &outW, &sa, 0); err != nil {
		return "", err
	}
	defer windows.CloseHandle(outR)
	if err := windows.SetHandleInformation(outR, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		windows.CloseHandle(outW)
		return "", err
	}
	var si windows.StartupInfo
	si.Cb = uint32(unsafe.Sizeof(si))
	si.Flags = windows.STARTF_USESHOWWINDOW | windows.STARTF_USESTDHANDLES
	si.ShowWindow = windows.SW_HIDE
	si.StdOutput = outW
	si.StdErr = outW
	cmdline := formatCommandLine(name, args...)
	pi, err := winsession.LaunchInSession(name, cmdline, &si, true, windows.CREATE_NO_WINDOW)
	windows.CloseHandle(outW)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(pi.Thread)
	defer windows.CloseHandle(pi.Process)
	outFile := os.NewFile(uintptr(outR), "")
	var output strings.Builder
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		b, _ := io.ReadAll(outFile)
		output.WriteString(decodeConsole(b))
		_ = outFile.Close()
	}()
	waitMs := uint32(timeout / time.Millisecond)
	if waitMs == 0 {
		waitMs = 1
	}
	wait, _ := windows.WaitForSingleObject(pi.Process, waitMs)
	if wait == uint32(windows.WAIT_TIMEOUT) {
		_ = windows.TerminateProcess(pi.Process, 1)
		<-readDone
		return output.String(), context.DeadlineExceeded
	}
	<-readDone
	var code uint32
	_ = windows.GetExitCodeProcess(pi.Process, &code)
	raw := output.String()
	if code != 0 {
		if raw != "" {
			return raw, fmt.Errorf("exit status %d", code)
		}
		return raw, fmt.Errorf("exit status %d", code)
	}
	return raw, nil
}

func formatCommandLine(name string, args ...string) string {
	parts := make([]string, 0, 1+len(args))
	if strings.ContainsAny(name, " \t\"") {
		parts = append(parts, `"`+strings.ReplaceAll(name, `"`, `\"`)+`"`)
	} else {
		parts = append(parts, name)
	}
	for _, arg := range args {
		if arg == "" {
			parts = append(parts, `""`)
			continue
		}
		if strings.ContainsAny(arg, " \t\"") {
			parts = append(parts, `"`+strings.ReplaceAll(arg, `"`, `\"`)+`"`)
		} else {
			parts = append(parts, arg)
		}
	}
	return strings.Join(parts, " ")
}

func runHiddenEnv(timeout time.Duration, extraEnv []string, name string, args ...string) (string, error) {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
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
