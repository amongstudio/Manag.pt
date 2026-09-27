//go:build !windows

package winreg

import "encoding/json"

func Get(json.RawMessage) (*KeyResult, error) {
	return nil, ErrUnsupported
}

func Set(json.RawMessage) (*WriteResult, error) {
	return nil, ErrUnsupported
}

func Delete(json.RawMessage) (*WriteResult, error) {
	return nil, ErrUnsupported
}
