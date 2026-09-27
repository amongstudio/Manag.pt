//go:build windows

package capture

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ole32 = windows.NewLazySystemDLL("ole32.dll")
	dxgi  = windows.NewLazySystemDLL("dxgi.dll")
	d3d11 = windows.NewLazySystemDLL("d3d11.dll")

	procCoInitializeEx       = ole32.NewProc("CoInitializeEx")
	procCoUninitialize       = ole32.NewProc("CoUninitialize")
	procCreateDXGIFactory1   = dxgi.NewProc("CreateDXGIFactory1")
	procD3D11CreateDevice    = d3d11.NewProc("D3D11CreateDevice")
)

func comMethod(object unsafe.Pointer, index uintptr) uintptr {
	vtable := *(*unsafe.Pointer)(object)
	return *(*uintptr)(unsafe.Add(vtable, index*unsafe.Sizeof(uintptr(0))))
}

func syscallCOM(object unsafe.Pointer, index uintptr, args ...uintptr) uintptr {
	all := make([]uintptr, 0, 1+len(args))
	all = append(all, uintptr(object))
	all = append(all, args...)
	r, _, _ := syscall.SyscallN(comMethod(object, index), all...)
	return r
}

func release(object unsafe.Pointer) {
	if object != nil {
		_, _, _ = syscall.SyscallN(comMethod(object, 2), uintptr(object))
	}
}

func failed(r uintptr) bool { return int32(r) < 0 }

func hrErr(name string, r uintptr) error {
	if failed(r) {
		return fmt.Errorf("%s HRESULT 0x%08x", name, uint32(r))
	}
	return nil
}

func coInit() (func(), error) {
	r, _, _ := procCoInitializeEx.Call(0, 0)
	switch uint32(r) {
	case 0, 1:
		return func() { _, _, _ = procCoUninitialize.Call() }, nil
	case 0x80010106:
		return func() {}, nil
	default:
		return func() {}, fmt.Errorf("CoInitializeEx HRESULT 0x%08x", uint32(r))
	}
}

func queryInterface(object unsafe.Pointer, iid windows.GUID) (unsafe.Pointer, error) {
	var out unsafe.Pointer
	r := syscallCOM(object, 0, uintptr(unsafe.Pointer(&iid)), uintptr(unsafe.Pointer(&out)))
	if err := hrErr("QueryInterface", r); err != nil {
		return nil, err
	}
	return out, nil
}
