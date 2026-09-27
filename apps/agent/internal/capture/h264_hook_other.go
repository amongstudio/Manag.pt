//go:build !windows

package capture

func H264Frame(int, int, int, int) ([]byte, int, int, error) {
	return nil, 0, 0, ErrUnsupported
}
