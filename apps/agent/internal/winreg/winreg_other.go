//go:build !windows

package winreg

import "encoding/json"

func Get(raw json.RawMessage) (*KeyResult, error) {
	if _, err := ParseGet(raw); err != nil {
		return nil, err
	}
	return nil, ErrUnsupported
}

func Set(raw json.RawMessage) (*WriteResult, error) {
	if _, err := ParseWrite(raw); err != nil {
		return nil, err
	}
	return nil, ErrUnsupported
}

func Delete(raw json.RawMessage) (*WriteResult, error) {
	if _, err := ParseDelete(raw); err != nil {
		return nil, err
	}
	return nil, ErrUnsupported
}
