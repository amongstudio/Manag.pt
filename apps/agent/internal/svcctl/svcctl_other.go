//go:build !windows

package svcctl

func List() (*ListResult, error) {
	return nil, ErrUnsupported
}

func Query(string) (*Info, error) {
	return nil, ErrUnsupported
}

func Start(string) (*ControlResult, error) {
	return nil, ErrUnsupported
}

func Stop(string) (*ControlResult, error) {
	return nil, ErrUnsupported
}

func Restart(string) (*ControlResult, error) {
	return nil, ErrUnsupported
}
