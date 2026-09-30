//go:build !windows

package winops

func InstallKBs([]string, string) (any, error) {
	return nil, ErrUnsupported
}
