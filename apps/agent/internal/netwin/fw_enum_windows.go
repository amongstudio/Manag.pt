//go:build windows

package netwin

import (
	"errors"
	"syscall"
	"unsafe"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

func forEachRule(rules *ole.IDispatch, fn func(*ole.IDispatch) error) error {
	if rules == nil {
		return ErrEnumFailed
	}
	v, err := oleutil.GetProperty(rules, "_NewEnum")
	if err != nil {
		v, err = oleutil.CallMethod(rules, "_NewEnum")
		if err != nil {
			return err
		}
	}
	defer v.Clear()
	unk := variantUnknown(v)
	if unk == nil {
		return ErrEnumFailed
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
		rule, owned, derr := dispatchFromVar(&item)
		if derr == nil && rule != nil {
			ferr := fn(rule)
			if owned {
				rule.Release()
			}
			_ = item.Clear()
			if ferr != nil {
				if errors.Is(ferr, errEnumDone) {
					return nil
				}
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

func variantUnknown(v *ole.VARIANT) *ole.IUnknown {
	if v == nil {
		return nil
	}
	if u := v.ToIUnknown(); u != nil {
		return u
	}
	if d := v.ToIDispatch(); d != nil {
		return (*ole.IUnknown)(unsafe.Pointer(d))
	}
	return nil
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
