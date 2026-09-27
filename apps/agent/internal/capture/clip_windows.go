//go:build windows

package capture

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	cfUnicodeText     = 13
	cfDIB             = 8
	cfHDROP           = 15
	gmemMoveable      = 0x0002
	wmClipboardUpdate = 0x031D
	hwndMessage       = ^uintptr(2) // HWND_MESSAGE
	clipImageMax      = 512 * 1024
	clipTextMax       = 256 * 1024
	clipHTMLMax       = 256 * 1024
	clipFilesMax      = 64
)

var (
	procOpenClipboard            = user32.NewProc("OpenClipboard")
	procCloseClipboard           = user32.NewProc("CloseClipboard")
	procEmptyClipboard           = user32.NewProc("EmptyClipboard")
	procSetClipboardData         = user32.NewProc("SetClipboardData")
	procGetClipboardData         = user32.NewProc("GetClipboardData")
	procIsClipboardFormatAvailable = user32.NewProc("IsClipboardFormatAvailable")
	procRegisterClipboardFormatW = user32.NewProc("RegisterClipboardFormatW")
	procAddClipboardFormatListener = user32.NewProc("AddClipboardFormatListener")
	procRemoveClipboardFormatListener = user32.NewProc("RemoveClipboardFormatListener")
	procRegisterClassExW         = user32.NewProc("RegisterClassExW")
	procCreateWindowExW          = user32.NewProc("CreateWindowExW")
	procDestroyWindow            = user32.NewProc("DestroyWindow")
	procDefWindowProcW           = user32.NewProc("DefWindowProcW")
	procPeekMessageW             = user32.NewProc("PeekMessageW")
	procTranslateMessage         = user32.NewProc("TranslateMessage")
	procDispatchMessageW         = user32.NewProc("DispatchMessageW")
	procGetModuleHandleW         = kernel32.NewProc("GetModuleHandleW")
	procGlobalAlloc              = kernel32.NewProc("GlobalAlloc")
	procGlobalLock               = kernel32.NewProc("GlobalLock")
	procGlobalUnlock             = kernel32.NewProc("GlobalUnlock")
	procGlobalSize               = kernel32.NewProc("GlobalSize")
	procGlobalFree               = kernel32.NewProc("GlobalFree")
	procRtlMoveMemory            = kernel32.NewProc("RtlMoveMemory")

	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	cfHTML uint32
	cfPNG  uint32

	clipOnce   sync.Once
	listenMu   sync.Mutex
	listenSubs []chan Clip
	listenStop chan struct{}
)

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

type msg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

type dropfiles struct {
	PFiles uint32
	X, Y   int32
	FNC    int32
	FWide  int32
}

var clipWndProc = windows.NewCallback(clipWndProcImpl)

func clipWndProcImpl(hwnd, msg, wParam, lParam uintptr) uintptr {
	if uint32(msg) == wmClipboardUpdate {
		if snap, err := snapshotLocal(); err == nil {
			broadcastClip(snap)
		}
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, msg, wParam, lParam)
	return r
}

func registerClipFormats() {
	h, _ := syscall.UTF16PtrFromString("HTML Format")
	r, _, _ := procRegisterClipboardFormatW.Call(uintptr(unsafe.Pointer(h)))
	cfHTML = uint32(r)
	p, _ := syscall.UTF16PtrFromString("PNG")
	r, _, _ = procRegisterClipboardFormatW.Call(uintptr(unsafe.Pointer(p)))
	cfPNG = uint32(r)
}

func openClipboard() error {
	var last error
	for i := 0; i < 10; i++ {
		r, _, err := procOpenClipboard.Call(0)
		if r != 0 {
			return nil
		}
		last = err
		time.Sleep(15 * time.Millisecond)
	}
	if last == nil {
		return errors.New("OpenClipboard")
	}
	return last
}

func formatAvailable(fmt uint32) bool {
	r, _, _ := procIsClipboardFormatAvailable.Call(uintptr(fmt))
	return r != 0
}

func lockClipboardData(format uint32) ([]byte, error) {
	h, _, err := procGetClipboardData.Call(uintptr(format))
	if h == 0 {
		return nil, err
	}
	ptr, _, _ := procGlobalLock.Call(h)
	if ptr == 0 {
		return nil, errors.New("GlobalLock")
	}
	defer procGlobalUnlock.Call(h)
	n, _, _ := procGlobalSize.Call(h)
	if n == 0 {
		return nil, nil
	}
	buf := make([]byte, int(n))
	procRtlMoveMemory.Call(uintptr(unsafe.Pointer(&buf[0])), ptr, n)
	return buf, nil
}

func capString(s string, n int) string {
	if n > 0 && len(s) > n {
		return s[:n]
	}
	return s
}

func snapshotLocal() (Clip, error) {
	clipOnce.Do(registerClipFormats)
	if err := openClipboard(); err != nil {
		return Clip{}, err
	}
	defer procCloseClipboard.Call()

	var c Clip
	if formatAvailable(cfUnicodeText) {
		if raw, err := lockClipboardData(cfUnicodeText); err == nil && len(raw) >= 2 {
			u16 := unsafe.Slice((*uint16)(unsafe.Pointer(&raw[0])), len(raw)/2)
			c.Text = capString(syscall.UTF16ToString(u16), clipTextMax)
		}
	}
	if cfHTML != 0 && formatAvailable(cfHTML) {
		if raw, err := lockClipboardData(cfHTML); err == nil && len(raw) > 0 {
			c.HTML = capString(string(bytes.TrimRight(raw, "\x00")), clipHTMLMax)
		}
	}
	if formatAvailable(cfHDROP) {
		if raw, err := lockClipboardData(cfHDROP); err == nil {
			c.Files = parseHDROP(raw)
		}
	}
	if cfPNG != 0 && formatAvailable(cfPNG) {
		if raw, err := lockClipboardData(cfPNG); err == nil && len(raw) > 0 && len(raw) <= clipImageMax {
			c.Image = raw
			c.Mime = "image/png"
		}
	} else if formatAvailable(cfDIB) && c.Image == nil {
		if raw, err := lockClipboardData(cfDIB); err == nil {
			if pngBytes, err := dibToPNG(raw); err == nil && len(pngBytes) <= clipImageMax {
				c.Image = pngBytes
				c.Mime = "image/png"
			}
		}
	}
	switch {
	case len(c.Files) > 0:
		c.Kind = "files"
	case len(c.Image) > 0:
		c.Kind = "image"
	case c.HTML != "":
		c.Kind = "html"
	default:
		c.Kind = "text"
	}
	if c.Text == "" && c.HTML == "" && len(c.Image) == 0 && len(c.Files) == 0 {
		return Clip{}, errors.New("clipboard empty")
	}
	return c, nil
}

func parseHDROP(raw []byte) []string {
	if len(raw) < int(unsafe.Sizeof(dropfiles{})) {
		return nil
	}
	df := *(*dropfiles)(unsafe.Pointer(&raw[0]))
	off := int(df.PFiles)
	if off < 0 || off >= len(raw) {
		return nil
	}
	var out []string
	if df.FWide != 0 {
		rest := raw[off:]
		u16 := unsafe.Slice((*uint16)(unsafe.Pointer(&rest[0])), len(rest)/2)
		start := 0
		for i, u := range u16 {
			if u != 0 {
				continue
			}
			if i == start {
				break
			}
			out = append(out, syscall.UTF16ToString(u16[start:i]))
			start = i + 1
			if len(out) >= clipFilesMax {
				break
			}
		}
		return out
	}
	start := off
	for i := off; i < len(raw); i++ {
		if raw[i] != 0 {
			continue
		}
		if i == start {
			break
		}
		out = append(out, string(raw[start:i]))
		start = i + 1
		if len(out) >= clipFilesMax {
			break
		}
	}
	return out
}

func dibToPNG(raw []byte) ([]byte, error) {
	if len(raw) < 40 {
		return nil, errors.New("dib too small")
	}
	w := int(int32(binary.LittleEndian.Uint32(raw[4:8])))
	hSigned := int32(binary.LittleEndian.Uint32(raw[8:12]))
	bitCount := binary.LittleEndian.Uint16(raw[14:16])
	if bitCount != 32 && bitCount != 24 {
		return nil, fmt.Errorf("dib bitCount %d", bitCount)
	}
	h := int(hSigned)
	topDown := false
	if h < 0 {
		h = -h
		topDown = true
	}
	if w < 1 || h < 1 || w > 7680 || h > 4320 {
		return nil, errors.New("dib size")
	}
	header := 40
	strideSrc := (w*int(bitCount) + 31) / 32 * 4
	need := header + strideSrc*h
	if len(raw) < need {
		return nil, errors.New("dib truncated")
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	bpp := int(bitCount) / 8
	for y := 0; y < h; y++ {
		sy := y
		if !topDown {
			sy = h - 1 - y
		}
		row := header + sy*strideSrc
		for x := 0; x < w; x++ {
			o := row + x*bpp
			if o+2 >= len(raw) {
				break
			}
			img.SetRGBA(x, y, color.RGBA{R: raw[o+2], G: raw[o+1], B: raw[o], A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func setLocalText(text string) error {
	return setLocalClip(Clip{Kind: "text", Text: text})
}

func setLocalClip(c Clip) error {
	clipOnce.Do(registerClipFormats)
	if c.Text == "" && c.HTML == "" && len(c.Image) == 0 && len(c.Files) == 0 {
		return errors.New("clipboard empty")
	}
	if err := openClipboard(); err != nil {
		return err
	}
	defer procCloseClipboard.Call()
	procEmptyClipboard.Call()
	var set int
	var last error
	put := func(err error) {
		if err != nil {
			last = err
			return
		}
		set++
	}
	if c.Text != "" {
		put(putUnicode(c.Text))
	}
	if c.HTML != "" {
		put(putHTML(c.HTML))
	}
	if len(c.Image) > 0 {
		put(putPNG(c.Image))
	}
	if len(c.Files) > 0 {
		put(putHDROP(c.Files))
	}
	if set == 0 {
		if last != nil {
			return last
		}
		return errors.New("clipboard empty")
	}
	return nil
}

func putGlobal(format uint32, raw []byte) error {
	if len(raw) == 0 {
		return errors.New("empty clipboard payload")
	}
	h, _, err := procGlobalAlloc.Call(gmemMoveable, uintptr(len(raw)))
	if h == 0 {
		return err
	}
	ptr, _, _ := procGlobalLock.Call(h)
	if ptr == 0 {
		procGlobalFree.Call(h)
		return errors.New("clipboard lock")
	}
	procRtlMoveMemory.Call(ptr, uintptr(unsafe.Pointer(&raw[0])), uintptr(len(raw)))
	procGlobalUnlock.Call(h)
	r, _, setErr := procSetClipboardData.Call(uintptr(format), h)
	if r == 0 {
		procGlobalFree.Call(h)
		return setErr
	}
	return nil
}

func putUnicode(text string) error {
	if len(text) > clipTextMax {
		text = text[:clipTextMax]
	}
	u16, err := syscall.UTF16FromString(text)
	if err != nil {
		return err
	}
	raw := make([]byte, len(u16)*2)
	for i, w := range u16 {
		binary.LittleEndian.PutUint16(raw[i*2:], w)
	}
	return putGlobal(cfUnicodeText, raw)
}

func wrapHTMLClipboard(fragment string) []byte {
	if strings.HasPrefix(fragment, "Version:") {
		return []byte(fragment)
	}
	prefix := `<html><body><!--StartFragment-->`
	suffix := `<!--EndFragment--></body></html>`
	headerFmt := "Version:0.9\r\nStartHTML:%010d\r\nEndHTML:%010d\r\nStartFragment:%010d\r\nEndFragment:%010d\r\n"
	dummy := fmt.Sprintf(headerFmt, 0, 0, 0, 0)
	startHTML := len(dummy)
	startFrag := startHTML + len(prefix)
	endFrag := startFrag + len(fragment)
	endHTML := endFrag + len(suffix)
	head := fmt.Sprintf(headerFmt, startHTML, endHTML, startFrag, endFrag)
	return []byte(head + prefix + fragment + suffix)
}

func putHTML(html string) error {
	if cfHTML == 0 {
		return errors.New("html format")
	}
	if len(html) > clipHTMLMax {
		html = html[:clipHTMLMax]
	}
	return putGlobal(cfHTML, wrapHTMLClipboard(html))
}

func putPNG(raw []byte) error {
	if cfPNG == 0 {
		return errors.New("png format")
	}
	if len(raw) > clipImageMax {
		return errors.New("image too large")
	}
	return putGlobal(cfPNG, raw)
}

func putHDROP(paths []string) error {
	if len(paths) > clipFilesMax {
		paths = paths[:clipFilesMax]
	}
	var names []uint16
	for _, p := range paths {
		if p == "" {
			continue
		}
		u, err := syscall.UTF16FromString(p)
		if err != nil {
			continue
		}
		names = append(names, u...)
	}
	if len(names) == 0 {
		return errors.New("no files")
	}
	names = append(names, 0)
	const headerSize = 20
	data := make([]byte, headerSize+len(names)*2)
	binary.LittleEndian.PutUint32(data[0:4], uint32(headerSize))
	binary.LittleEndian.PutUint32(data[16:20], 1)
	for i, w := range names {
		binary.LittleEndian.PutUint16(data[headerSize+i*2:], w)
	}
	return putGlobal(cfHDROP, data)
}

func broadcastClip(c Clip) {
	listenMu.Lock()
	defer listenMu.Unlock()
	for _, ch := range listenSubs {
		select {
		case ch <- c:
		default:
		}
	}
}

func listenLocal(stop <-chan struct{}) <-chan Clip {
	out := make(chan Clip, 8)
	listenMu.Lock()
	listenSubs = append(listenSubs, out)
	needStart := listenStop == nil
	if needStart {
		listenStop = make(chan struct{})
	}
	listenMu.Unlock()
	if needStart {
		go clipMessageLoop()
	}
	go func() {
		<-stop
		listenMu.Lock()
		filtered := listenSubs[:0]
		for _, ch := range listenSubs {
			if ch != out {
				filtered = append(filtered, ch)
			}
		}
		listenSubs = filtered
		if len(listenSubs) == 0 && listenStop != nil {
			close(listenStop)
			listenStop = nil
		}
		listenMu.Unlock()
		close(out)
	}()
	return out
}

func clipMessageLoop() {
	className, _ := syscall.UTF16PtrFromString("PCManagerClipWnd")
	mod, _, _ := procGetModuleHandleW.Call(0)
	wc := wndClassEx{
		Size:      uint32(unsafe.Sizeof(wndClassEx{})),
		WndProc:   clipWndProc,
		Instance:  windows.Handle(mod),
		ClassName: className,
	}
	_, _, _ = procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	hwnd, _, _ := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(className)), 0, 0, 0, 0, 0, 0, hwndMessage, 0, mod, 0)
	useListener := false
	var seq uint32
	if hwnd != 0 {
		r, _, _ := procAddClipboardFormatListener.Call(hwnd)
		useListener = r != 0
		if !useListener {
			seq = clipboardSequence()
		}
		defer func() {
			if useListener {
				procRemoveClipboardFormatListener.Call(hwnd)
			}
			procDestroyWindow.Call(hwnd)
		}()
	} else {
		seq = clipboardSequence()
	}

	const pmRemove = 1
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		listenMu.Lock()
		stop := listenStop
		listenMu.Unlock()
		if stop == nil {
			return
		}
		var m msg
		if hwnd != 0 {
			for {
				r, _, _ := procPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), hwnd, 0, 0, pmRemove)
				if r == 0 {
					break
				}
				procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
				procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
			}
		}
		if !useListener {
			n := clipboardSequence()
			if n != seq {
				seq = n
				if snap, err := snapshotLocal(); err == nil {
					broadcastClip(snap)
				}
			}
		}
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
	}
}

func clipboardSequence() uint32 {
	r, _, _ := user32.NewProc("GetClipboardSequenceNumber").Call()
	return uint32(r)
}
