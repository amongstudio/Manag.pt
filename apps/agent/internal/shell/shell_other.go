//go:build !windows

package shell

import (
	"errors"
	"io"
)

type Session struct {
	done chan struct{}
	out  chan []byte
}

func Open(string, int, int) (*Session, error) {
	return nil, errUnsupported
}

func (s *Session) Write([]byte) (int, error) { return 0, errUnsupported }

func (s *Session) Resize(int, int) error { return errUnsupported }

func (s *Session) Close() {
	if s == nil {
		return
	}
	select {
	case <-s.done:
	default:
		close(s.done)
	}
}

func (s *Session) Output() <-chan []byte {
	if s == nil {
		ch := make(chan []byte)
		close(ch)
		return ch
	}
	return s.out
}

func (s *Session) Done() <-chan struct{} {
	if s == nil {
		ch := make(chan struct{})
		close(ch)
		return ch
	}
	return s.done
}

func (s *Session) Err() error { return errUnsupported }

func Supported() bool { return false }

var errUnsupported = errors.New(ReasonUnsupported)

func IsUnsupported(err error) bool { return errors.Is(err, errUnsupported) }

func IsNoSession(error) bool { return false }

var _ io.Writer = (*Session)(nil)
