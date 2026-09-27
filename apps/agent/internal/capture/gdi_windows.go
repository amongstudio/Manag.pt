//go:build windows

package capture

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	srcCopy             = 0x00CC0020
	halftone            = 4
	dibRGBColors        = 0
	smXVirtualScreen    = 76
	smYVirtualScreen    = 77
	smCXVirtualScreen   = 78
	smCYVirtualScreen   = 79
	monitorInfoPrimary  = 1
	pwRenderFullContent = 2
	biRGB               = 0
)

var (
	user32  = windows.NewLazySystemDLL("user32.dll")
	gdi32   = windows.NewLazySystemDLL("gdi32.dll")
	magDll  = windows.NewLazySystemDLL("Magnification.dll")

	procGetDC                   = user32.NewProc("GetDC")
	procReleaseDC               = user32.NewProc("ReleaseDC")
	procGetDesktopWindow        = user32.NewProc("GetDesktopWindow")
	procPrintWindow             = user32.NewProc("PrintWindow")
	procGetSystemMetrics        = user32.NewProc("GetSystemMetrics")
	procEnumDisplayMonitors     = user32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfoW         = user32.NewProc("GetMonitorInfoW")
	procCreateCompatibleDC      = gdi32.NewProc("CreateCompatibleDC")
	procDeleteDC                = gdi32.NewProc("DeleteDC")
	procCreateDIBSection        = gdi32.NewProc("CreateDIBSection")
	procSelectObject            = gdi32.NewProc("SelectObject")
	procDeleteObject            = gdi32.NewProc("DeleteObject")
	procStretchBlt              = gdi32.NewProc("StretchBlt")
	procSetStretchBltMode       = gdi32.NewProc("SetStretchBltMode")
	procSetBrushOrgEx           = gdi32.NewProc("SetBrushOrgEx")
	procBitBlt                  = gdi32.NewProc("BitBlt")
	procMagInitialize           = magDll.NewProc("MagInitialize")
	procMagUninitialize         = magDll.NewProc("MagUninitialize")
)

type bitmapInfo struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type monitorInfoEx struct {
	CbSize    uint32
	Monitor   winRect
	Work      winRect
	Flags     uint32
	Device    [32]uint16
}

func metric(idx int) int {
	v, _, _ := procGetSystemMetrics.Call(uintptr(idx))
	return int(int32(v))
}

func gdiDisplays() []DisplayInfo {
	var out []DisplayInfo
	cb := windows.NewCallback(func(hmon, hdc, lprc, dwData uintptr) uintptr {
		var info monitorInfoEx
		info.CbSize = uint32(unsafe.Sizeof(info))
		r, _, _ := procGetMonitorInfoW.Call(hmon, uintptr(unsafe.Pointer(&info)))
		if r == 0 {
			return 1
		}
		rct := info.Monitor
		out = append(out, DisplayInfo{
			ID:     len(out),
			X:      int(rct.Left),
			Y:      int(rct.Top),
			Width:  int(rct.Right - rct.Left),
			Height: int(rct.Bottom - rct.Top),
		})
		return 1
	})
	_, _, _ = procEnumDisplayMonitors.Call(0, 0, cb, 0)
	if len(out) == 0 {
		w, h := metric(smCXVirtualScreen), metric(smCYVirtualScreen)
		if w < 1 {
			w = metric(0)
		}
		if h < 1 {
			h = metric(1)
		}
		out = []DisplayInfo{{ID: 0, X: metric(smXVirtualScreen), Y: metric(smYVirtualScreen), Width: w, Height: h}}
	}
	return out
}

func displayBounds(display int) (x, y, w, h int) {
	list := gdiDisplays()
	if len(list) == 0 {
		return 0, 0, metric(0), metric(1)
	}
	if display < 0 || display >= len(list) {
		display = 0
	}
	d := list[display]
	return d.X, d.Y, d.Width, d.Height
}

func scaledSize(srcW, srcH, maxWidth int) (int, int) {
	if srcW < 1 {
		srcW = 1
	}
	if srcH < 1 {
		srcH = 1
	}
	if maxWidth <= 0 || srcW <= maxWidth {
		return srcW, srcH
	}
	dstH := srcH * maxWidth / srcW
	if dstH < 1 {
		dstH = 1
	}
	return maxWidth, dstH
}

func createTopDownDIB(hdc uintptr, w, h int) (bmp uintptr, bits []byte, err error) {
	var bi bitmapInfo
	bi.Size = 40
	bi.Width = int32(w)
	bi.Height = -int32(h)
	bi.Planes = 1
	bi.BitCount = 32
	bi.Compression = biRGB
	var ptr unsafe.Pointer
	r, _, e := procCreateDIBSection.Call(hdc, uintptr(unsafe.Pointer(&bi)), dibRGBColors, uintptr(unsafe.Pointer(&ptr)), 0, 0)
	if r == 0 || ptr == nil {
		if e != nil {
			return 0, nil, e
		}
		return 0, nil, fmt.Errorf("CreateDIBSection")
	}
	n := w * h * 4
	bits = unsafe.Slice((*byte)(ptr), n)
	return r, bits, nil
}

func gdiGrab(display, maxWidth int, usePrint bool) (*Frame, error) {
	sx, sy, sw, sh := displayBounds(display)
	dw, dh := scaledSize(sw, sh, maxWidth)
	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return nil, fmt.Errorf("GetDC")
	}
	defer procReleaseDC.Call(0, screen)

	mem, _, _ := procCreateCompatibleDC.Call(screen)
	if mem == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC")
	}
	defer procDeleteDC.Call(mem)

	bmp, bits, err := createTopDownDIB(mem, dw, dh)
	if err != nil {
		return nil, err
	}
	defer procDeleteObject.Call(bmp)
	old, _, _ := procSelectObject.Call(mem, bmp)
	defer procSelectObject.Call(mem, old)

	_, _, _ = procSetStretchBltMode.Call(mem, halftone)
	_, _, _ = procSetBrushOrgEx.Call(mem, 0, 0, 0)

	var ok uintptr
	if usePrint {
		desk, _, _ := procGetDesktopWindow.Call()
		ok, _, _ = procPrintWindow.Call(desk, mem, pwRenderFullContent)
		if ok == 0 {
			ok, _, _ = procBitBlt.Call(mem, 0, 0, uintptr(dw), uintptr(dh), screen, uintptr(sx), uintptr(sy), srcCopy)
		}
	} else if dw == sw && dh == sh {
		ok, _, _ = procBitBlt.Call(mem, 0, 0, uintptr(dw), uintptr(dh), screen, uintptr(sx), uintptr(sy), srcCopy)
	} else {
		ok, _, _ = procStretchBlt.Call(mem, 0, 0, uintptr(dw), uintptr(dh), screen, uintptr(sx), uintptr(sy), uintptr(sw), uintptr(sh), srcCopy)
	}
	if ok == 0 {
		return nil, fmt.Errorf("gdi blit failed")
	}
	pix := make([]byte, len(bits))
	copy(pix, bits)
	if isMostlyBlack(pix, dw*4, dw, dh) {
		return nil, ErrBlackFrame
	}
	return &Frame{Width: dw, Height: dh, Stride: dw * 4, Pix: pix}, nil
}

func stretchBGRA(src []byte, srcW, srcH, srcStride, maxWidth int) (*Frame, error) {
	dstW, dstH := scaledSize(srcW, srcH, maxWidth)
	if dstW == srcW && dstH == srcH && srcStride == srcW*4 {
		return &Frame{Width: srcW, Height: srcH, Stride: srcStride, Pix: src}, nil
	}
	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return nil, fmt.Errorf("GetDC")
	}
	defer procReleaseDC.Call(0, screen)
	srcDC, _, _ := procCreateCompatibleDC.Call(screen)
	dstDC, _, _ := procCreateCompatibleDC.Call(screen)
	if srcDC == 0 || dstDC == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC")
	}
	defer procDeleteDC.Call(srcDC)
	defer procDeleteDC.Call(dstDC)

	srcBmp, srcBits, err := createTopDownDIB(srcDC, srcW, srcH)
	if err != nil {
		return nil, err
	}
	defer procDeleteObject.Call(srcBmp)
	for y := 0; y < srcH; y++ {
		copy(srcBits[y*srcW*4:(y+1)*srcW*4], src[y*srcStride:y*srcStride+srcW*4])
	}
	dstBmp, dstBits, err := createTopDownDIB(dstDC, dstW, dstH)
	if err != nil {
		return nil, err
	}
	defer procDeleteObject.Call(dstBmp)
	oldS, _, _ := procSelectObject.Call(srcDC, srcBmp)
	oldD, _, _ := procSelectObject.Call(dstDC, dstBmp)
	defer procSelectObject.Call(srcDC, oldS)
	defer procSelectObject.Call(dstDC, oldD)
	_, _, _ = procSetStretchBltMode.Call(dstDC, halftone)
	_, _, _ = procSetBrushOrgEx.Call(dstDC, 0, 0, 0)
	ok, _, _ := procStretchBlt.Call(dstDC, 0, 0, uintptr(dstW), uintptr(dstH), srcDC, 0, 0, uintptr(srcW), uintptr(srcH), srcCopy)
	if ok == 0 {
		return nil, fmt.Errorf("StretchBlt")
	}
	pix := make([]byte, len(dstBits))
	copy(pix, dstBits)
	return &Frame{Width: dstW, Height: dstH, Stride: dstW * 4, Pix: pix}, nil
}

func magAvailable() bool {
	if err := magDll.Load(); err != nil {
		return false
	}
	r, _, _ := procMagInitialize.Call()
	if r == 0 {
		return false
	}
	_, _, _ = procMagUninitialize.Call()
	return true
}
