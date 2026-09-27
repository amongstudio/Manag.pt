//go:build windows && !lite

package desktop

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ole32       = windows.NewLazySystemDLL("ole32.dll")
	mfplat      = windows.NewLazySystemDLL("mfplat.dll")
	mfreadwrite = windows.NewLazySystemDLL("mfreadwrite.dll")

	procCoCreateInstance          = ole32.NewProc("CoCreateInstance")
	procCoInitializeEx            = ole32.NewProc("CoInitializeEx")
	procCoUninitialize            = ole32.NewProc("CoUninitialize")
	procCoTaskMemFree             = ole32.NewProc("CoTaskMemFree")
	procMFStartup                 = mfplat.NewProc("MFStartup")
	procMFTEnumEx                 = mfplat.NewProc("MFTEnumEx")
	procMFCreateMediaType         = mfplat.NewProc("MFCreateMediaType")
	procMFCreateMemoryBuffer      = mfplat.NewProc("MFCreateMemoryBuffer")
	procMFCreateSample            = mfplat.NewProc("MFCreateSample")
	procMFCreateAttributes        = mfplat.NewProc("MFCreateAttributes")
	procMFCreateSinkWriterFromURL = mfreadwrite.NewProc("MFCreateSinkWriterFromURL")
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

func callHR(name string, object unsafe.Pointer, index uintptr, args ...uintptr) error {
	if object == nil {
		return fmt.Errorf("%s: nil COM object", name)
	}
	return hresult(name, syscallCOM(object, index, args...))
}

func hresult(name string, r uintptr) error {
	if int32(r) < 0 {
		return fmt.Errorf("%s failed with HRESULT 0x%08x", name, uint32(r))
	}
	return nil
}

func callProc(name string, proc *windows.LazyProc, args ...uintptr) error {
	r, _, _ := proc.Call(args...)
	return hresult(name, r)
}

func release(object unsafe.Pointer) {
	if object != nil {
		_, _, _ = syscall.SyscallN(comMethod(object, 2), uintptr(object))
	}
}

func coInit() (func(), error) {
	r, _, _ := procCoInitializeEx.Call(0, 0) // COINIT_MULTITHREADED
	switch uint32(r) {
	case 0, 1: // S_OK, S_FALSE
		return func() { _, _, _ = procCoUninitialize.Call() }, nil
	case 0x80010106: // RPC_E_CHANGED_MODE
		return func() {}, nil
	default:
		return func() {}, fmt.Errorf("CoInitializeEx HRESULT 0x%08x", uint32(r))
	}
}

func coCreate(clsid, iid windows.GUID) (unsafe.Pointer, error) {
	return coCreateCtx(clsid, iid, 1) // CLSCTX_INPROC_SERVER
}

func coCreateCtx(clsid, iid windows.GUID, ctx uintptr) (unsafe.Pointer, error) {
	var ptr unsafe.Pointer
	r, _, _ := procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&clsid)),
		0,
		ctx,
		uintptr(unsafe.Pointer(&iid)),
		uintptr(unsafe.Pointer(&ptr)),
	)
	if err := hresult("CoCreateInstance", r); err != nil {
		return nil, err
	}
	return ptr, nil
}

func coCreateTransform(clsid windows.GUID) (unsafe.Pointer, error) {
	unk, err := coCreate(clsid, iidIUnknown)
	if err != nil {
		if codec, cErr := coCreate(clsid, iidICodecAPI); cErr == nil {
			xf, qerr := transformFromUnknown(codec)
			release(codec)
			if qerr == nil {
				return xf, nil
			}
		}
		return coCreate(clsid, iidIMFTransform)
	}
	xf, qerr := transformFromUnknown(unk)
	release(unk)
	if qerr != nil {
		return nil, qerr
	}
	return xf, nil
}

func transformFromUnknown(unk unsafe.Pointer) (unsafe.Pointer, error) {
	if unk == nil {
		return nil, fmt.Errorf("nil COM object")
	}
	xf, err := queryInterface(unk, iidIMFTransform)
	if err == nil {
		return xf, nil
	}
	codec, cErr := queryInterface(unk, iidICodecAPI)
	if cErr != nil {
		return nil, err
	}
	xf, qerr := queryInterface(codec, iidIMFTransform)
	release(codec)
	if qerr != nil {
		return nil, qerr
	}
	return xf, nil
}

func createAttributes(hint uint32) (unsafe.Pointer, error) {
	var attrs unsafe.Pointer
	if err := callProc("MFCreateAttributes", procMFCreateAttributes, uintptr(unsafe.Pointer(&attrs)), uintptr(hint)); err != nil {
		return nil, err
	}
	return attrs, nil
}

func coTaskMemFree(p unsafe.Pointer) {
	if p != nil {
		_, _, _ = procCoTaskMemFree.Call(uintptr(p))
	}
}

func queryInterface(object unsafe.Pointer, iid windows.GUID) (unsafe.Pointer, error) {
	if object == nil {
		return nil, fmt.Errorf("QueryInterface: nil COM object")
	}
	var out unsafe.Pointer
	r, _, _ := syscall.SyscallN(comMethod(object, 0), uintptr(object), uintptr(unsafe.Pointer(&iid)), uintptr(unsafe.Pointer(&out)))
	runtime.KeepAlive(iid)
	if err := hresult("QueryInterface", r); err != nil {
		return nil, err
	}
	if out == nil {
		return nil, fmt.Errorf("QueryInterface returned nil")
	}
	return out, nil
}

func createMediaType() (unsafe.Pointer, error) {
	var mt unsafe.Pointer
	if err := callProc("MFCreateMediaType", procMFCreateMediaType, uintptr(unsafe.Pointer(&mt))); err != nil {
		return nil, err
	}
	return mt, nil
}

func setGUID(obj unsafe.Pointer, key, value windows.GUID) error {
	err := callHR("IMFAttributes.SetGUID", obj, 24, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&value)))
	runtime.KeepAlive(key)
	runtime.KeepAlive(value)
	return err
}

func setUINT32(obj unsafe.Pointer, key windows.GUID, value uint32) error {
	err := callHR("IMFAttributes.SetUINT32", obj, 21, uintptr(unsafe.Pointer(&key)), uintptr(value))
	runtime.KeepAlive(key)
	return err
}

func setUINT64(obj unsafe.Pointer, key windows.GUID, value uint64) error {
	err := callHR("IMFAttributes.SetUINT64", obj, 22, uintptr(unsafe.Pointer(&key)), uintptr(value))
	runtime.KeepAlive(key)
	return err
}

func getGUID(obj unsafe.Pointer, key windows.GUID) (windows.GUID, error) {
	var g windows.GUID
	err := callHR("IMFAttributes.GetGUID", obj, 10, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&g)))
	runtime.KeepAlive(key)
	return g, err
}

func packPair(hi, lo uint32) uint64 {
	return uint64(hi)<<32 | uint64(lo)
}
