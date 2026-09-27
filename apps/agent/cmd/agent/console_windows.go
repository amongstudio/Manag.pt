//go:build windows

package main

import (
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

func attachParentConsole() {
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	attach := kernel32.NewProc("AttachConsole")
	r, _, _ := attach.Call(^uintptr(0)) // ATTACH_PARENT_PROCESS
	if r == 0 {
		return
	}
	reopenStd()
}

func allocConsole() {
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	alloc := kernel32.NewProc("AllocConsole")
	r, _, _ := alloc.Call()
	if r == 0 {
		return
	}
	reopenStd()
}

func reopenStd() {
	stdout, _ := syscall.GetStdHandle(syscall.STD_OUTPUT_HANDLE)
	stderr, _ := syscall.GetStdHandle(syscall.STD_ERROR_HANDLE)
	stdin, _ := syscall.GetStdHandle(syscall.STD_INPUT_HANDLE)
	os.Stdout = os.NewFile(uintptr(stdout), "stdout")
	os.Stderr = os.NewFile(uintptr(stderr), "stderr")
	os.Stdin = os.NewFile(uintptr(stdin), "stdin")
}

func ensureConsoleForCLI() {
	attachParentConsole()
}

func ensureConsoleForDebug() {
	attachParentConsole()
	if os.Stdout == nil {
		allocConsole()
		return
	}
	fi, err := os.Stdout.Stat()
	if err != nil || fi == nil {
		allocConsole()
	}
}
