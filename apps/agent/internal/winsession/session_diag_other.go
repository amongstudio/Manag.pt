//go:build !windows

package winsession

func DescribeInteractiveSession() InteractiveSession {
	return InteractiveSession{}
}
