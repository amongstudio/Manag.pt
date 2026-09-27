//go:build windows

package capture

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	dxgiErrorNotFound     = 0x887A0002
	dxgiErrorWaitTimeout  = 0x887A0027
	dxgiErrorAccessLost   = 0x887A0026
	dxgiErrorAccessDenied = 0x887A002B
	dxgiFormatBGRA        = 87
	d3d11SDKVersion       = 7
	d3d11UsageStaging     = 3
	d3d11CPUAccessRead    = 0x20000
	d3d11MapRead          = 1
	d3dDriverUnknown      = 0
	d3dFeature11          = 0xb000
	d3dFeature101         = 0xa100
	d3dFeature100         = 0xa000
	d3dCreateBGRA         = 0x20
	dxgiRotationIdentity  = 1
)

var (
	iidIDXGIFactory1   = windows.GUID{Data1: 0x770aae78, Data2: 0xf26f, Data3: 0x4dba, Data4: [8]byte{0xa8, 0x29, 0x25, 0x3c, 0x83, 0xf1, 0xaf, 0x84}}
	iidIDXGIOutput1    = windows.GUID{Data1: 0x00cddea8, Data2: 0x939b, Data3: 0x4b83, Data4: [8]byte{0xa3, 0x40, 0xa6, 0x85, 0x22, 0x66, 0x66, 0xcc}}
	iidID3D11Texture2D = windows.GUID{Data1: 0x6f15aaf2, Data2: 0xd208, Data3: 0x4e89, Data4: [8]byte{0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}}
)

type winRect struct {
	Left, Top, Right, Bottom int32
}

type outputDesc struct {
	DeviceName         [32]uint16
	DesktopCoordinates winRect
	AttachedToDesktop  int32
	Rotation           uint32
	Monitor            windows.Handle
}

type tex2dDesc struct {
	Width, Height, MipLevels, ArraySize uint32
	Format                              uint32
	SampleCount                         uint32
	SampleQuality                       uint32
	Usage                               uint32
	BindFlags                           uint32
	CPUAccessFlags                      uint32
	MiscFlags                           uint32
}

type mappedSub struct {
	Data       uintptr
	RowPitch   uint32
	DepthPitch uint32
}

type outDuplFrameInfo struct {
	LastPresentTime           int64
	LastMouseUpdateTime       int64
	AccumulatedFrames         uint32
	RectsCoalesced            int32
	ProtectedContentMaskedOut int32
	PointerX                  int32
	PointerY                  int32
	PointerVisible            int32
	TotalMetadataBufferSize   uint32
	PointerShapeBufferSize    uint32
}

type dxgiOutput struct {
	adapter unsafe.Pointer
	output  unsafe.Pointer
	desc    outputDesc
}

type dxgiDup struct {
	factory  unsafe.Pointer
	adapter  unsafe.Pointer
	output   unsafe.Pointer
	output1  unsafe.Pointer
	device   unsafe.Pointer
	ctx      unsafe.Pointer
	dup      unsafe.Pointer
	staging  unsafe.Pointer
	stageW   int
	stageH   int
	bounds   winRect
	last     *Frame
	longWait bool
	cpuA     []byte
	cpuB     []byte
	useA     bool
}

func (d *dxgiDup) close() {
	if d == nil {
		return
	}
	release(d.staging)
	release(d.dup)
	release(d.ctx)
	release(d.device)
	release(d.output1)
	release(d.output)
	release(d.adapter)
	release(d.factory)
	*d = dxgiDup{}
}

func enumDXGIOutputs() ([]dxgiOutput, error) {
	var factory unsafe.Pointer
	r, _, _ := procCreateDXGIFactory1.Call(uintptr(unsafe.Pointer(&iidIDXGIFactory1)), uintptr(unsafe.Pointer(&factory)))
	if err := hrErr("CreateDXGIFactory1", r); err != nil {
		return nil, err
	}
	defer release(factory)

	var out []dxgiOutput
	for ai := uint32(0); ; ai++ {
		var adapter unsafe.Pointer
		r := syscallCOM(factory, 12, uintptr(ai), uintptr(unsafe.Pointer(&adapter)))
		if uint32(r) == dxgiErrorNotFound {
			break
		}
		if failed(r) {
			break
		}
		for oi := uint32(0); ; oi++ {
			var output unsafe.Pointer
			r := syscallCOM(adapter, 7, uintptr(oi), uintptr(unsafe.Pointer(&output)))
			if uint32(r) == dxgiErrorNotFound {
				break
			}
			if failed(r) {
				break
			}
			var desc outputDesc
			if err := hrErr("GetDesc", syscallCOM(output, 7, uintptr(unsafe.Pointer(&desc)))); err != nil {
				release(output)
				continue
			}
			if desc.AttachedToDesktop == 0 {
				release(output)
				continue
			}
			syscallCOM(adapter, 1) // AddRef — stored on dxgiOutput
			out = append(out, dxgiOutput{adapter: adapter, output: output, desc: desc})
		}
		release(adapter)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no DXGI outputs")
	}
	return out, nil
}

func dxgiDisplays() []DisplayInfo {
	outs, err := enumDXGIOutputs()
	if err != nil {
		return nil
	}
	defer func() {
		for _, o := range outs {
			release(o.output)
			release(o.adapter)
		}
	}()
	info := make([]DisplayInfo, 0, len(outs))
	for i, o := range outs {
		r := o.desc.DesktopCoordinates
		info = append(info, DisplayInfo{
			ID:     i,
			X:      int(r.Left),
			Y:      int(r.Top),
			Width:  int(r.Right - r.Left),
			Height: int(r.Bottom - r.Top),
		})
	}
	return info
}

func openDXGI(display int) (*dxgiDup, error) {
	outs, err := enumDXGIOutputs()
	if err != nil {
		return nil, err
	}
	if display < 0 || display >= len(outs) {
		display = 0
	}
	chosen := outs[display]
	for i, o := range outs {
		if i != display {
			release(o.output)
			release(o.adapter)
		}
	}
	d := &dxgiDup{adapter: chosen.adapter, output: chosen.output, bounds: chosen.desc.DesktopCoordinates}
	if chosen.desc.Rotation != 0 && chosen.desc.Rotation != dxgiRotationIdentity {
		d.close()
		return nil, fmt.Errorf("rotated output")
	}

	var factory unsafe.Pointer
	r, _, _ := procCreateDXGIFactory1.Call(uintptr(unsafe.Pointer(&iidIDXGIFactory1)), uintptr(unsafe.Pointer(&factory)))
	if err := hrErr("CreateDXGIFactory1", r); err != nil {
		d.close()
		return nil, err
	}
	d.factory = factory

	levels := [...]uint32{d3dFeature11, d3dFeature101, d3dFeature100}
	var feat uint32
	r, _, _ = procD3D11CreateDevice.Call(
		uintptr(d.adapter),
		d3dDriverUnknown,
		0,
		d3dCreateBGRA,
		uintptr(unsafe.Pointer(&levels[0])),
		uintptr(len(levels)),
		d3d11SDKVersion,
		uintptr(unsafe.Pointer(&d.device)),
		uintptr(unsafe.Pointer(&feat)),
		uintptr(unsafe.Pointer(&d.ctx)),
	)
	if err := hrErr("D3D11CreateDevice", r); err != nil {
		d.close()
		return nil, err
	}
	out1, err := queryInterface(d.output, iidIDXGIOutput1)
	if err != nil {
		d.close()
		return nil, err
	}
	d.output1 = out1
	r = syscallCOM(d.output1, 22, uintptr(d.device), uintptr(unsafe.Pointer(&d.dup)))
	if err := hrErr("DuplicateOutput", r); err != nil {
		d.close()
		return nil, err
	}
	return d, nil
}

func (d *dxgiDup) grab() (*Frame, error) {
	if d == nil || d.dup == nil || d.ctx == nil {
		return nil, fmt.Errorf("dxgi not ready")
	}
	timeout := uint32(80)
	if !d.longWait {
		timeout = 1200
		d.longWait = true
	}
	var info outDuplFrameInfo
	var resource unsafe.Pointer
	r := syscallCOM(d.dup, 8, uintptr(timeout), uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&resource)))
	code := uint32(r)
	if code == dxgiErrorWaitTimeout {
		if d.last != nil {
			pix := append([]byte(nil), d.last.Pix...)
			return &Frame{Width: d.last.Width, Height: d.last.Height, Stride: d.last.Stride, Pix: pix}, nil
		}
		return nil, ErrTimeout
	}
	if code == dxgiErrorAccessLost || code == dxgiErrorAccessDenied {
		return nil, fmt.Errorf("dxgi access lost")
	}
	if err := hrErr("AcquireNextFrame", r); err != nil {
		return nil, err
	}
	defer func() {
		release(resource)
		_ = syscallCOM(d.dup, 14)
	}()
	tex, err := queryInterface(resource, iidID3D11Texture2D)
	if err != nil {
		return nil, err
	}
	defer release(tex)

	var desc tex2dDesc
	_ = syscallCOM(tex, 10, uintptr(unsafe.Pointer(&desc)))
	w, h := int(desc.Width), int(desc.Height)
	if w < 1 || h < 1 {
		return nil, fmt.Errorf("empty desktop texture")
	}
	if d.staging == nil || d.stageW != w || d.stageH != h || desc.Format != dxgiFormatBGRA {
		release(d.staging)
		d.staging = nil
		stageDesc := tex2dDesc{
			Width:          desc.Width,
			Height:         desc.Height,
			MipLevels:      1,
			ArraySize:      1,
			Format:         desc.Format,
			SampleCount:    1,
			Usage:          d3d11UsageStaging,
			CPUAccessFlags: d3d11CPUAccessRead,
		}
		r := syscallCOM(d.device, 5, uintptr(unsafe.Pointer(&stageDesc)), 0, uintptr(unsafe.Pointer(&d.staging)))
		if err := hrErr("CreateTexture2D", r); err != nil {
			return nil, err
		}
		d.stageW, d.stageH = w, h
	}
	_ = syscallCOM(d.ctx, 47, uintptr(d.staging), uintptr(tex))
	var mapped mappedSub
	r = syscallCOM(d.ctx, 14, uintptr(d.staging), 0, d3d11MapRead, 0, uintptr(unsafe.Pointer(&mapped)))
	if err := hrErr("Map", r); err != nil {
		return nil, err
	}
	defer syscallCOM(d.ctx, 15, uintptr(d.staging), 0)

	stride := int(mapped.RowPitch)
	pix := d.cpuCopy(mapped.Data, stride*h)
	if isMostlyBlack(pix, stride, w, h) {
		return nil, ErrBlackFrame
	}
	f := &Frame{Width: w, Height: h, Stride: stride, Pix: pix}
	d.last = f
	return f, nil
}

func (d *dxgiDup) cpuCopy(src uintptr, need int) []byte {
	if need < 1 {
		return nil
	}
	var buf *[]byte
	if d.useA {
		buf = &d.cpuA
	} else {
		buf = &d.cpuB
	}
	d.useA = !d.useA
	if cap(*buf) < need {
		*buf = make([]byte, need)
	} else {
		*buf = (*buf)[:need]
	}
	if src != 0 && len(*buf) > 0 {
		procRtlMoveMemory.Call(uintptr(unsafe.Pointer(&(*buf)[0])), src, uintptr(need))
	}
	return *buf
}
