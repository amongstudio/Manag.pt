//go:build windows && !lite

package desktop

import (
	"errors"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/pc-manager/agent/internal/screenshot"
	"github.com/pc-manager/agent/internal/winsession"
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	procSendInput        = user32.NewProc("SendInput")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
	procOpenClipboard    = user32.NewProc("OpenClipboard")
	procCloseClipboard   = user32.NewProc("CloseClipboard")
	procEmptyClipboard   = user32.NewProc("EmptyClipboard")
	procSetClipboardData = user32.NewProc("SetClipboardData")
	procGetClipboardData = user32.NewProc("GetClipboardData")
	procClipboardSeq     = user32.NewProc("GetClipboardSequenceNumber")
	procGlobalAlloc      = kernel32.NewProc("GlobalAlloc")
	procGlobalLock       = kernel32.NewProc("GlobalLock")
	procGlobalUnlock     = kernel32.NewProc("GlobalUnlock")
	procGlobalSize       = kernel32.NewProc("GlobalSize")
	procGlobalFree       = kernel32.NewProc("GlobalFree")
	procRtlMoveMemory    = kernel32.NewProc("RtlMoveMemory")
)

const (
	inputMouse        = 0
	inputKeyboard     = 1
	mouseMove         = 0x0001
	mouseLeftDown     = 0x0002
	mouseLeftUp       = 0x0004
	mouseRightDown    = 0x0008
	mouseRightUp      = 0x0010
	mouseMiddleDown   = 0x0020
	mouseMiddleUp     = 0x0040
	mouseXDown        = 0x0080
	mouseXUp          = 0x0100
	mouseWheel        = 0x0800
	mouseVirtualDesk  = 0x4000
	mouseAbsolute     = 0x8000
	xbutton1          = 0x0001
	xbutton2          = 0x0002
	keyeventfExtended = 0x0001
	keyeventfKeyup    = 0x0002
	keyeventfUnicode  = 0x0004
	vkShift           = 0x10
	vkControl         = 0x11
	vkMenu            = 0x12
	vkLShift          = 0xA0
	vkRShift          = 0xA1
	vkLControl        = 0xA2
	vkRControl        = 0xA3
	vkLMenu           = 0xA4
	vkRMenu           = 0xA5
	vkBack            = 0x08
	vkTab             = 0x09
	vkReturn          = 0x0D
	vkEscape          = 0x1B
	vkSpace           = 0x20
	vkPageUp          = 0x21
	vkPageDown        = 0x22
	vkEnd             = 0x23
	vkHome            = 0x24
	vkLeft            = 0x25
	vkUp              = 0x26
	vkRight           = 0x27
	vkDown            = 0x28
	vkInsert          = 0x2D
	vkDelete          = 0x2E
	vkLWin            = 0x5B
	vkRWin            = 0x5C
	vkCaps            = 0x14
	smCXScreen        = 0
	smCYScreen        = 1
	smXVIRTUALSCREEN  = 76
	smYVIRTUALSCREEN  = 77
	smCXVIRTUALSCREEN = 78
	smCYVIRTUALSCREEN = 79
	cfUnicodeText     = 13
	gmemMoveable      = 0x0002
	mouseHeldLeft     = 1 << 0
	mouseHeldMiddle   = 1 << 1
	mouseHeldRight    = 1 << 2
	mouseHeldX1       = 1 << 3
	mouseHeldX2       = 1 << 4
)

type winMouseInput struct {
	Type      uint32
	_         uint32
	Dx        int32
	Dy        int32
	MouseData uint32
	Flags     uint32
	Time      uint32
	_2        uint32
	Extra     uintptr
}

type winKeybdInput struct {
	Type  uint32
	_     uint32
	Vk    uint16
	Scan  uint16
	Flags uint32
	Time  uint32
	_2    uint32
	Extra uintptr
	_3    [8]byte
}

var (
	heldMu    sync.Mutex
	heldVK    = map[uint16]struct{}{}
	heldMouse uint32
)

func inputSupported() bool { return !winsession.InSession0() }

func clipSupported() bool {
	if winsession.HasConsoleUser() {
		return true
	}
	return !winsession.InSession0()
}

func clipboardWatchSupported() bool { return clipSupported() }

func clipboardWatchMode() string {
	if !clipSupported() {
		return "off"
	}
	if winsession.InSession0() {
		return "helper"
	}
	return "listener"
}

func clipboardSequence() uint32 {
	r, _, _ := procClipboardSeq.Call()
	return uint32(r)
}

func metric(idx int) int32 {
	v, _, _ := procGetSystemMetrics.Call(uintptr(idx))
	return int32(v)
}

func sendMouse(flags uint32, dx, dy int32, data uint32) {
	if winsession.InSession0() {
		return
	}
	in := winMouseInput{
		Type:      inputMouse,
		Dx:        dx,
		Dy:        dy,
		MouseData: data,
		Flags:     flags,
	}
	_, _, _ = procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
}

func sendKey(vk, scan uint16, flags uint32) {
	if winsession.InSession0() {
		return
	}
	in := winKeybdInput{
		Type:  inputKeyboard,
		Vk:    vk,
		Scan:  scan,
		Flags: flags,
	}
	_, _, _ = procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
}

func inject(ev inputEvent, display int) {
	switch ev.T {
	case "move":
		moveTo(ev, display)
	case "down":
		moveTo(ev, display)
		flags, data := buttonDown(ev.B)
		noteMouse(ev.B, true)
		sendMouse(flags, 0, 0, data)
	case "up":
		moveTo(ev, display)
		flags, data := buttonUp(ev.B)
		noteMouse(ev.B, false)
		sendMouse(flags, 0, 0, data)
	case "wheel":
		moveTo(ev, display)
		delta := int32(-ev.Dy)
		if delta == 0 {
			return
		}
		sendMouse(mouseWheel, 0, 0, uint32(delta))
	case "key":
		injectKey(ev)
	}
}

func moveTo(ev inputEvent, display int) {
	dx, dy := 0, 0
	dw, dh := int(metric(smCXScreen)), int(metric(smCYScreen))
	displays := screenshot.Displays()
	if len(displays) > 0 {
		if display < 0 || display >= len(displays) {
			display = 0
		}
		d := displays[display]
		dx, dy, dw, dh = d.X, d.Y, d.Width, d.Height
	}
	if dw < 1 {
		dw = 1
	}
	if dh < 1 {
		dh = 1
	}
	vx, vy := int(metric(smXVIRTUALSCREEN)), int(metric(smYVIRTUALSCREEN))
	vw, vh := int(metric(smCXVIRTUALSCREEN)), int(metric(smCYVIRTUALSCREEN))
	if vw < 1 {
		vw = dw
	}
	if vh < 1 {
		vh = dh
	}
	nx, ny := ev.X, ev.Y
	if nx > 1 || ny > 1 {
		nx = ev.X / float64(dw)
		ny = ev.Y / float64(dh)
	}
	ax, ay := pointerToAbsolute(nx, ny, dx, dy, dw, dh, vx, vy, vw, vh)
	sendMouse(mouseMove|mouseAbsolute|mouseVirtualDesk, ax, ay, 0)
}

func buttonDown(b int) (flags, data uint32) {
	switch b {
	case 1:
		return mouseMiddleDown, 0
	case 2:
		return mouseRightDown, 0
	case 3:
		return mouseXDown, xbutton1
	case 4:
		return mouseXDown, xbutton2
	default:
		return mouseLeftDown, 0
	}
}

func buttonUp(b int) (flags, data uint32) {
	switch b {
	case 1:
		return mouseMiddleUp, 0
	case 2:
		return mouseRightUp, 0
	case 3:
		return mouseXUp, xbutton1
	case 4:
		return mouseXUp, xbutton2
	default:
		return mouseLeftUp, 0
	}
}

func mouseBit(b int) uint32 {
	switch b {
	case 1:
		return mouseHeldMiddle
	case 2:
		return mouseHeldRight
	case 3:
		return mouseHeldX1
	case 4:
		return mouseHeldX2
	default:
		return mouseHeldLeft
	}
}

func noteMouse(b int, down bool) {
	heldMu.Lock()
	defer heldMu.Unlock()
	bit := mouseBit(b)
	if down {
		heldMouse |= bit
	} else {
		heldMouse &^= bit
	}
}

func noteKey(vk uint16, down bool) {
	if vk == 0 {
		return
	}
	heldMu.Lock()
	defer heldMu.Unlock()
	if down {
		heldVK[vk] = struct{}{}
	} else {
		delete(heldVK, vk)
	}
}

func releaseHeldInput() {
	heldMu.Lock()
	vks := make([]uint16, 0, len(heldVK))
	for vk := range heldVK {
		vks = append(vks, vk)
	}
	heldVK = map[uint16]struct{}{}
	mouse := heldMouse
	heldMouse = 0
	heldMu.Unlock()
	for _, vk := range vks {
		flags := uint32(keyeventfKeyup)
		if extendedVK(vk) {
			flags |= keyeventfExtended
		}
		sendKey(vk, 0, flags)
	}
	if mouse&mouseHeldLeft != 0 {
		sendMouse(mouseLeftUp, 0, 0, 0)
	}
	if mouse&mouseHeldMiddle != 0 {
		sendMouse(mouseMiddleUp, 0, 0, 0)
	}
	if mouse&mouseHeldRight != 0 {
		sendMouse(mouseRightUp, 0, 0, 0)
	}
	if mouse&mouseHeldX1 != 0 {
		sendMouse(mouseXUp, 0, 0, xbutton1)
	}
	if mouse&mouseHeldX2 != 0 {
		sendMouse(mouseXUp, 0, 0, xbutton2)
	}
}

func injectKey(ev inputEvent) {
	vk := vkFromCode(ev.Code, ev.Key)
	if vk != 0 {
		flags := uint32(0)
		if extendedVK(vk) {
			flags |= keyeventfExtended
		}
		if !ev.Down {
			flags |= keyeventfKeyup
		}
		noteKey(vk, ev.Down)
		sendKey(vk, 0, flags)
		return
	}
	if ev.Key == "" || ev.Key == "Unidentified" || ev.Key == "Dead" || ev.Key == "Process" {
		return
	}
	if len(ev.Key) == 1 && ev.Key[0] < 32 {
		return
	}
	units := utf16.Encode([]rune(ev.Key))
	flags := uint32(keyeventfUnicode)
	if !ev.Down {
		flags |= keyeventfKeyup
	}
	for _, u := range units {
		sendKey(0, u, flags)
	}
}

func extendedVK(vk uint16) bool {
	switch vk {
	case vkInsert, vkDelete, vkHome, vkEnd, vkPageUp, vkPageDown, vkLeft, vkUp, vkRight, vkDown, vkRControl, vkRMenu:
		return true
	default:
		return false
	}
}

func vkFromCode(code, key string) uint16 {
	switch code {
	case "ShiftLeft":
		return vkLShift
	case "ShiftRight":
		return vkRShift
	case "ControlLeft":
		return vkLControl
	case "ControlRight":
		return vkRControl
	case "AltLeft":
		return vkLMenu
	case "AltRight":
		return vkRMenu
	case "MetaLeft", "OSLeft":
		return vkLWin
	case "MetaRight", "OSRight":
		return vkRWin
	case "CapsLock":
		return vkCaps
	case "Backspace":
		return vkBack
	case "Tab":
		return vkTab
	case "Enter":
		return vkReturn
	case "Escape":
		return vkEscape
	case "Space":
		return vkSpace
	case "ArrowLeft":
		return vkLeft
	case "ArrowUp":
		return vkUp
	case "ArrowRight":
		return vkRight
	case "ArrowDown":
		return vkDown
	case "Delete":
		return vkDelete
	case "Insert":
		return vkInsert
	case "Home":
		return vkHome
	case "End":
		return vkEnd
	case "PageUp":
		return vkPageUp
	case "PageDown":
		return vkPageDown
	case "F1":
		return 0x70
	case "F2":
		return 0x71
	case "F3":
		return 0x72
	case "F4":
		return 0x73
	case "F5":
		return 0x74
	case "F6":
		return 0x75
	case "F7":
		return 0x76
	case "F8":
		return 0x77
	case "F9":
		return 0x78
	case "F10":
		return 0x79
	case "F11":
		return 0x7A
	case "F12":
		return 0x7B
	case "Minus":
		return 0xBD
	case "Equal":
		return 0xBB
	case "BracketLeft":
		return 0xDB
	case "BracketRight":
		return 0xDD
	case "Backslash":
		return 0xDC
	case "Semicolon":
		return 0xBA
	case "Quote":
		return 0xDE
	case "Backquote":
		return 0xC0
	case "Comma":
		return 0xBC
	case "Period":
		return 0xBE
	case "Slash":
		return 0xBF
	case "Numpad0":
		return 0x60
	case "Numpad1":
		return 0x61
	case "Numpad2":
		return 0x62
	case "Numpad3":
		return 0x63
	case "Numpad4":
		return 0x64
	case "Numpad5":
		return 0x65
	case "Numpad6":
		return 0x66
	case "Numpad7":
		return 0x67
	case "Numpad8":
		return 0x68
	case "Numpad9":
		return 0x69
	case "NumpadAdd":
		return 0x6B
	case "NumpadSubtract":
		return 0x6D
	case "NumpadMultiply":
		return 0x6A
	case "NumpadDivide":
		return 0x6F
	case "NumpadDecimal":
		return 0x6E
	case "NumpadEnter":
		return vkReturn
	}
	if len(key) == 1 {
		c := key[0]
		if c >= 'a' && c <= 'z' {
			return uint16(c - 32)
		}
		if c >= 'A' && c <= 'Z' {
			return uint16(c)
		}
		if c >= '0' && c <= '9' {
			return uint16(c)
		}
		switch key {
		case " ":
			return vkSpace
		}
	}
	return 0
}

func openClipboard() error {
	var last error
	for i := 0; i < 10; i++ {
		r, _, err := procOpenClipboard.Call(0)
		if r != 0 {
			return nil
		}
		last = err
		time.Sleep(20 * time.Millisecond)
	}
	if last == nil {
		return errors.New("OpenClipboard")
	}
	return last
}

func setClipboard(text string) error {
	u16, err := syscall.UTF16FromString(text)
	if err != nil {
		return err
	}
	size := len(u16) * 2
	h, _, err := procGlobalAlloc.Call(uintptr(gmemMoveable), uintptr(size))
	if h == 0 {
		return err
	}
	ptr, _, _ := procGlobalLock.Call(h)
	if ptr == 0 {
		procGlobalFree.Call(h)
		return errors.New("clipboard lock")
	}
	procRtlMoveMemory.Call(ptr, uintptr(unsafe.Pointer(&u16[0])), uintptr(size))
	procGlobalUnlock.Call(h)
	if err := openClipboard(); err != nil {
		procGlobalFree.Call(h)
		return err
	}
	defer procCloseClipboard.Call()
	procEmptyClipboard.Call()
	r, _, setErr := procSetClipboardData.Call(uintptr(cfUnicodeText), h)
	if r == 0 {
		procGlobalFree.Call(h)
		return setErr
	}
	return nil
}

func getClipboard() (string, error) {
	if err := openClipboard(); err != nil {
		return "", err
	}
	defer procCloseClipboard.Call()
	h, _, err := procGetClipboardData.Call(uintptr(cfUnicodeText))
	if h == 0 {
		return "", err
	}
	ptr, _, _ := procGlobalLock.Call(h)
	if ptr == 0 {
		return "", errors.New("clipboard lock")
	}
	defer procGlobalUnlock.Call(h)
	n, _, _ := procGlobalSize.Call(h)
	if n < 2 {
		return "", nil
	}
	count := int(n) / 2
	buf := make([]uint16, count)
	procRtlMoveMemory.Call(uintptr(unsafe.Pointer(&buf[0])), ptr, n)
	return syscall.UTF16ToString(buf), nil
}
