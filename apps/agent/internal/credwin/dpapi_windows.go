//go:build windows

package credwin

import (
	"encoding/base64"
	"errors"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func dpapiDecrypt(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty")
	}
	in := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, 0, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	plain := make([]byte, out.Size)
	copy(plain, unsafe.Slice(out.Data, int(out.Size)))
	return plain, nil
}

func decodeBase64StdOrURL(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(s)
}
