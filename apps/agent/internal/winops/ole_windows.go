//go:build windows

package winops

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

const (
	wmiWBEMDenied           = 0x80041003
	wmiWBEMInvalidNamespace = 0x8004100E
	wmiWBEMInvalidClass     = 0x80041010
	wmiWBEMNotFound         = 0x80041002
	wmiWBEMProviderNotFound = 0x80041011
)

func withSTA(fn func() error) error {
	errCh := make(chan error, 1)
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				errCh <- fmt.Errorf("com_panic: %v", rec)
			}
		}()
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		errCh <- withSTALocked(fn)
	}()
	return <-errCh
}

func withSTALocked(fn func() error) error {
	uninit := false
	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		code := oleCode(err)
		if code == rpcEChangedMode {
			uninit = false
		} else if code != ole.S_OK && code != sFalse {
			return err
		}
	} else {
		uninit = true
	}
	if uninit {
		defer ole.CoUninitialize()
	}
	return fn()
}

func createDispatch(progID string) (*ole.IDispatch, error) {
	unk, err := oleutil.CreateObject(progID)
	if err != nil {
		return nil, err
	}
	if unk == nil {
		return nil, errors.New("create_object_failed")
	}
	disp, err := unk.QueryInterface(ole.IID_IDispatch)
	unk.Release()
	if err != nil {
		return nil, err
	}
	if disp == nil {
		return nil, errors.New("query_dispatch_failed")
	}
	return disp, nil
}

func dispatchFromVar(v *ole.VARIANT) (*ole.IDispatch, bool) {
	if v == nil {
		return nil, false
	}
	if d := v.ToIDispatch(); d != nil {
		d.AddRef()
		return d, true
	}
	unk := v.ToIUnknown()
	if unk == nil {
		return nil, false
	}
	d, err := unk.QueryInterface(ole.IID_IDispatch)
	if err != nil || d == nil {
		return nil, false
	}
	return d, true
}

func propString(obj *ole.IDispatch, name string) string {
	if obj == nil {
		return ""
	}
	v, err := oleutil.GetProperty(obj, name)
	if err != nil {
		return ""
	}
	defer v.Clear()
	return strings.TrimSpace(fmt.Sprint(variantValue(v)))
}

func propBool(obj *ole.IDispatch, name string) bool {
	if obj == nil {
		return false
	}
	v, err := oleutil.GetProperty(obj, name)
	if err != nil {
		return false
	}
	defer v.Clear()
	switch n := variantValue(v).(type) {
	case bool:
		return n
	case int16:
		return n != 0
	case int32:
		return n != 0
	case int64:
		return n != 0
	case uint32:
		return n != 0
	default:
		return v.Val != 0
	}
}

func propInt(obj *ole.IDispatch, name string) int {
	if obj == nil {
		return 0
	}
	v, err := oleutil.GetProperty(obj, name)
	if err != nil {
		return 0
	}
	defer v.Clear()
	return intFromValue(variantValue(v), v.Val)
}

func propTime(obj *ole.IDispatch, name string) string {
	if obj == nil {
		return ""
	}
	v, err := oleutil.GetProperty(obj, name)
	if err != nil {
		return ""
	}
	defer v.Clear()
	return formatWhen(variantValue(v))
}

func variantValue(v *ole.VARIANT) any {
	if v == nil {
		return nil
	}
	return v.Value()
}

func intFromValue(val any, raw int64) int {
	switch n := val.(type) {
	case int:
		return n
	case int8:
		return int(n)
	case int16:
		return int(n)
	case int32:
		return int(n)
	case int64:
		return int(n)
	case uint:
		return int(n)
	case uint8:
		return int(n)
	case uint16:
		return int(n)
	case uint32:
		return int(n)
	case uint64:
		return int(n)
	case float64:
		return int(n)
	case bool:
		if n {
			return 1
		}
		return 0
	default:
		return int(raw)
	}
}

func formatWhen(val any) string {
	switch t := val.(type) {
	case time.Time:
		if t.Year() < 2000 {
			return ""
		}
		return t.UTC().Format(time.RFC3339)
	case string:
		return parseCIMDate(t)
	case float64:
		// OLE DATE: days since 1899-12-30
		if t < 2 {
			return ""
		}
		base := time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)
		sec := int64(t * 24 * 60 * 60)
		out := base.Add(time.Duration(sec) * time.Second)
		if out.Year() < 2000 {
			return ""
		}
		return out.UTC().Format(time.RFC3339)
	default:
		s := strings.TrimSpace(fmt.Sprint(t))
		if s == "" || s == "<nil>" || s == "0" {
			return ""
		}
		return parseCIMDate(s)
	}
}

func isAccessDenied(err error) bool {
	if err == nil {
		return false
	}
	code := oleCode(err)
	if code == ole.E_ACCESSDENIED || code == wmiWBEMDenied || code == 0x80070005 {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "access") && strings.Contains(msg, "deni")
}

func isWMIMissing(err error) bool {
	if err == nil {
		return false
	}
	switch oleCode(err) {
	case wmiWBEMInvalidNamespace, wmiWBEMInvalidClass, wmiWBEMNotFound, wmiWBEMProviderNotFound:
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "invalid namespace") ||
		strings.Contains(msg, "invalid class") ||
		strings.Contains(msg, "not found") ||
		strings.Contains(msg, "0x8004100e") ||
		strings.Contains(msg, "0x80041010")
}

func withWMI(namespace string, fn func(svc *ole.IDispatch) error) error {
	return withSTA(func() error {
		locator, err := createDispatch("WbemScripting.SWbemLocator")
		if err != nil {
			return err
		}
		defer locator.Release()
		svcVar, err := oleutil.CallMethod(locator, "ConnectServer", ".", namespace)
		if err != nil {
			return err
		}
		svc, owned := dispatchFromVar(svcVar)
		_ = svcVar.Clear()
		if svc == nil {
			return errors.New("wmi_connect_failed")
		}
		if owned {
			defer svc.Release()
		}
		return fn(svc)
	})
}

func wmiQuery(svc *ole.IDispatch, query string, each func(item *ole.IDispatch) error) error {
	setVar, err := oleutil.CallMethod(svc, "ExecQuery", query)
	if err != nil {
		return err
	}
	set, owned := dispatchFromVar(setVar)
	_ = setVar.Clear()
	if set == nil {
		return errors.New("wmi_query_failed")
	}
	if owned {
		defer set.Release()
	}
	return forEachDispatch(set, each)
}

func forEachDispatch(disp *ole.IDispatch, fn func(*ole.IDispatch) error) error {
	if disp == nil {
		return errors.New("wmi_query_failed")
	}
	v, err := oleutil.GetProperty(disp, "_NewEnum")
	if err != nil {
		v, err = oleutil.CallMethod(disp, "_NewEnum")
		if err != nil {
			return err
		}
	}
	defer v.Clear()
	unk := v.ToIUnknown()
	if unk == nil {
		if d := v.ToIDispatch(); d != nil {
			unk = (*ole.IUnknown)(unsafe.Pointer(d))
		}
	}
	if unk == nil {
		return errors.New("wmi_enum_failed")
	}
	enum, err := unk.IEnumVARIANT(ole.IID_IEnumVariant)
	if err != nil || enum == nil {
		return err
	}
	defer enum.Release()
	for {
		item, fetched, nerr := nextVariant(enum)
		if fetched == 0 {
			return nil
		}
		obj, keep := dispatchFromVar(&item)
		if obj != nil {
			ferr := fn(obj)
			if keep {
				obj.Release()
			}
			_ = item.Clear()
			if ferr != nil {
				return ferr
			}
		} else {
			_ = item.Clear()
		}
		if nerr != nil && fetched == 0 {
			return nerr
		}
	}
}

func nextVariant(enum *ole.IEnumVARIANT) (ole.VARIANT, uint32, error) {
	var item ole.VARIANT
	var fetched uint32
	hr, _, _ := syscall.Syscall6(
		enum.VTable().Next,
		4,
		uintptr(unsafe.Pointer(enum)),
		1,
		uintptr(unsafe.Pointer(&item)),
		uintptr(unsafe.Pointer(&fetched)),
		0,
		0)
	if hr != 0 && hr != sFalse {
		return item, fetched, ole.NewError(hr)
	}
	return item, fetched, nil
}

func intPtrIfPresent(obj *ole.IDispatch, name string) *int {
	if obj == nil {
		return nil
	}
	v, err := oleutil.GetProperty(obj, name)
	if err != nil {
		return nil
	}
	defer v.Clear()
	n := intFromValue(variantValue(v), v.Val)
	if n < 0 || n > 36500 {
		return nil
	}
	out := n
	return &out
}

func wmiMethodInt(item *ole.IDispatch, method, outProp string) (int, bool) {
	obj := wmiExec(item, method)
	if obj == nil {
		return 0, false
	}
	defer obj.Release()
	return propInt(obj, outProp), true
}

func wmiMethodString(item *ole.IDispatch, method, outProp string) string {
	obj := wmiExec(item, method)
	if obj == nil {
		return ""
	}
	defer obj.Release()
	return propString(obj, outProp)
}

func wmiExec(item *ole.IDispatch, method string) *ole.IDispatch {
	if item == nil || method == "" {
		return nil
	}
	v, err := oleutil.CallMethod(item, "ExecMethod_", method)
	if err != nil {
		v, err = oleutil.CallMethod(item, method)
		if err != nil {
			return nil
		}
	}
	obj, keep := dispatchFromVar(v)
	_ = v.Clear()
	if obj == nil {
		return nil
	}
	if !keep {
		obj.AddRef()
	}
	return obj
}
