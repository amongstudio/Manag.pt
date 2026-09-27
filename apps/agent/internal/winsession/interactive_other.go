//go:build !windows

package winsession

func RunInteractive(fn func() error) error {
	if fn == nil {
		return nil
	}
	return fn()
}

func RunInteractiveUser(fn func() error) error {
	return RunInteractive(fn)
}
