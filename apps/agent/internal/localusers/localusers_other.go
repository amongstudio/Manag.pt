//go:build !windows

package localusers

func List() (*Result, error) { return nil, ErrUnsupported }

func Apply(ActionRequest) (map[string]any, error) { return nil, ErrUnsupported }
