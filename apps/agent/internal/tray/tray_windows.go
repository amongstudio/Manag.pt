//go:build windows

package tray

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"github.com/lxn/win"
	"github.com/pc-manager/agent/internal/notify"
	"github.com/pc-manager/agent/internal/winsvc"
	"golang.org/x/sys/windows"
)

const (
	wmTray    = win.WM_USER + 32
	timerID   = 1
	idStatus  = 1
	idInstall = 10
	idHide    = 11
	idStop    = 12
	idExit    = 13
	idStart   = 14
)

type host struct {
	opts    Options
	hwnd    win.HWND
	nid     win.NOTIFYICONDATA
	icon    win.HICON
	pendMu  sync.Mutex
	pending []notify.Message
}

var current *host

func Run(opts Options) {
	if opts.StatusPort <= 0 {
		opts.StatusPort = 17890
	}
	if !singleInstance() {
		return
	}
	runtime.LockOSThread()
	h := &host{opts: opts}
	current = h
	defer func() { current = nil }()
	h.loop()
}

func singleInstance() bool {
	name, err := windows.UTF16PtrFromString("Local\\PCManagerAgentTray")
	if err != nil {
		return true
	}
	mod := windows.NewLazySystemDLL("kernel32.dll")
	proc := mod.NewProc("CreateMutexW")
	r0, _, e1 := proc.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if r0 == 0 {
		return true
	}
	if e1 == windows.ERROR_ALREADY_EXISTS {
		_ = windows.CloseHandle(windows.Handle(r0))
		return false
	}
	return true
}

func (h *host) loop() {
	runtime.LockOSThread()
	className, _ := syscall.UTF16PtrFromString("PCManagerAgentTray")
	hinst := win.GetModuleHandle(nil)
	wc := win.WNDCLASSEX{
		LpfnWndProc:   syscall.NewCallback(trayWndProc),
		HInstance:     hinst,
		LpszClassName: className,
		HCursor:       win.LoadCursor(0, win.MAKEINTRESOURCE(win.IDC_ARROW)),
		HIcon:         win.LoadIcon(0, win.MAKEINTRESOURCE(win.IDI_APPLICATION)),
	}
	wc.CbSize = uint32(unsafe.Sizeof(wc))
	if win.RegisterClassEx(&wc) == 0 {
		return
	}
	hwnd := win.CreateWindowEx(0, className, className, win.WS_OVERLAPPED, 0, 0, 0, 0, 0, 0, hinst, nil)
	if hwnd == 0 {
		return
	}
	h.hwnd = hwnd
	h.icon = loadTrayIcon()
	h.nid = win.NOTIFYICONDATA{
		HWnd:             hwnd,
		UID:              1,
		UFlags:           win.NIF_MESSAGE | win.NIF_ICON | win.NIF_TIP,
		UCallbackMessage: wmTray,
		HIcon:            h.icon,
	}
	h.nid.CbSize = uint32(unsafe.Sizeof(h.nid))
	h.setTip("Mnag.pt Agent")
	if !win.Shell_NotifyIcon(win.NIM_ADD, &h.nid) {
		return
	}
	h.nid.UVersion = win.NOTIFYICON_VERSION_4
	win.Shell_NotifyIcon(win.NIM_SETVERSION, &h.nid)
	win.SetTimer(hwnd, timerID, 2000, 0)
	h.refreshTip()
	go h.serveNotify()

	var msg win.MSG
	for win.GetMessage(&msg, 0, 0, 0) != 0 {
		win.TranslateMessage(&msg)
		win.DispatchMessage(&msg)
	}
	win.KillTimer(hwnd, timerID)
	win.Shell_NotifyIcon(win.NIM_DELETE, &h.nid)
	if h.icon != 0 {
		win.DestroyIcon(h.icon)
	}
	win.DestroyWindow(hwnd)
}

func trayWndProc(hwnd win.HWND, msg uint32, wParam, lParam uintptr) uintptr {
	h := current
	if h == nil {
		return win.DefWindowProc(hwnd, msg, wParam, lParam)
	}
	switch msg {
	case wmTray:
		switch lParam {
		case win.WM_RBUTTONUP, win.WM_LBUTTONUP:
			h.showMenu()
		}
		return 0
	case wmNotifyBalloon:
		h.drainBalloons()
		return 0
	case win.WM_TIMER:
		if wParam == timerID {
			h.refreshTip()
		}
		return 0
	case win.WM_DESTROY:
		win.PostQuitMessage(0)
		return 0
	}
	return win.DefWindowProc(hwnd, msg, wParam, lParam)
}

func (h *host) snapshot() Snapshot {
	snap := FetchNow(h.opts.StatusPort, h.opts.DataDir)
	snap.Installed = winsvc.AgentInstalled()
	if snap.Installed && !snap.Running && winsvc.AgentRunning() {
		snap.Running = true
	}
	return snap
}

func (h *host) refreshTip() {
	snap := h.snapshot()
	title := Format(snap)
	if h.opts.Version != "" {
		title = "Mnag.pt Agent " + h.opts.Version + " — " + title
	}
	h.setTip(title)
	win.Shell_NotifyIcon(win.NIM_MODIFY, &h.nid)
}

func (h *host) setTip(s string) {
	u, _ := syscall.UTF16FromString(s)
	n := len(u)
	if n > len(h.nid.SzTip) {
		n = len(h.nid.SzTip)
		u = u[:n]
		u[n-1] = 0
	}
	copy(h.nid.SzTip[:], u)
}

func (h *host) showMenu() {
	snap := h.snapshot()
	menu := win.CreatePopupMenu()
	if menu == 0 {
		return
	}
	defer win.DestroyMenu(menu)
	appendMenu(menu, win.MF_STRING|win.MF_GRAYED, idStatus, Format(snap))
	appendMenu(menu, win.MF_SEPARATOR, 0, "")
	if !snap.Installed {
		appendMenu(menu, win.MF_STRING, idInstall, "Install as service")
	}
	if snap.Installed && !snap.Running {
		appendMenu(menu, win.MF_STRING, idStart, "Start agent")
	}
	appendMenu(menu, win.MF_STRING, idHide, "Hide icon")
	if snap.Installed {
		appendMenu(menu, win.MF_STRING, idStop, "Stop agent")
	}
	appendMenu(menu, win.MF_STRING, idExit, "Exit tray")

	var pt win.POINT
	win.GetCursorPos(&pt)
	win.SetForegroundWindow(h.hwnd)
	cmd := win.TrackPopupMenu(menu, win.TPM_RETURNCMD|win.TPM_RIGHTBUTTON, pt.X, pt.Y, 0, h.hwnd, nil)
	win.PostMessage(h.hwnd, win.WM_NULL, 0, 0)
	switch cmd {
	case idHide, idExit:
		win.PostQuitMessage(0)
	case idStop:
		h.onStop()
	case idStart:
		h.onStart()
	case idInstall:
		h.onInstall()
	}
}

func (h *host) onStart() {
	if !winsvc.IsElevated() {
		if err := winsvc.RelaunchElevated("start"); err != nil {
			winsvc.Alert("Start agent", err.Error())
		}
		return
	}
	if err := winsvc.CoordinatedStart(); err != nil {
		winsvc.Alert("Start agent", err.Error())
	}
	h.refreshTip()
}

func (h *host) onStop() {
	if !winsvc.Confirm("Stop Mnag.pt Agent", "Stop the helper watchdog and the agent service?\n\nThey will stay down until you start them again. Ending only the agent in Task Manager would bring it back.") {
		return
	}
	if !winsvc.IsElevated() {
		if err := winsvc.RelaunchElevated("stop"); err != nil {
			winsvc.Alert("Stop agent", err.Error())
		}
		return
	}
	if err := winsvc.CoordinatedStop(); err != nil {
		winsvc.Alert("Stop agent", err.Error())
	}
	h.refreshTip()
}

func (h *host) onInstall() {
	if !winsvc.IsElevated() {
		if err := winsvc.RelaunchElevated("self-install"); err != nil {
			winsvc.Alert("Install as service", "Installation needs administrator permission.\n\n"+err.Error())
		}
		return
	}
	if err := winsvc.SelfInstall(); err != nil {
		winsvc.Alert("Install as service", err.Error())
	}
	h.refreshTip()
}

func appendMenu(menu win.HMENU, flags, id uint32, title string) {
	var p *uint16
	if title != "" {
		p, _ = syscall.UTF16PtrFromString(title)
	}
	proc := windows.NewLazySystemDLL("user32.dll").NewProc("AppendMenuW")
	_, _, _ = proc.Call(uintptr(menu), uintptr(flags), uintptr(id), uintptr(unsafe.Pointer(p)))
}

func loadTrayIcon() win.HICON {
	if exe, err := os.Executable(); err == nil {
		p, err := syscall.UTF16PtrFromString(exe)
		if err == nil {
			if ic := win.ExtractIcon(0, p, 0); ic != 0 && ic != 1 {
				return ic
			}
		}
	}
	if len(iconBytes) == 0 {
		return win.LoadIcon(0, win.MAKEINTRESOURCE(win.IDI_APPLICATION))
	}
	dir, err := os.MkdirTemp("", "pcmgr-tray-*")
	if err != nil {
		return win.LoadIcon(0, win.MAKEINTRESOURCE(win.IDI_APPLICATION))
	}
	path := filepath.Join(dir, "icon.ico")
	if err := os.WriteFile(path, iconBytes, 0o644); err != nil {
		return win.LoadIcon(0, win.MAKEINTRESOURCE(win.IDI_APPLICATION))
	}
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return win.LoadIcon(0, win.MAKEINTRESOURCE(win.IDI_APPLICATION))
	}
	h := win.HICON(win.LoadImage(0, p, win.IMAGE_ICON, 0, 0, win.LR_LOADFROMFILE))
	if h == 0 {
		return win.LoadIcon(0, win.MAKEINTRESOURCE(win.IDI_APPLICATION))
	}
	return h
}
