package screenshot

import (
	"errors"
	"testing"

	"github.com/pc-manager/agent/internal/capture"
)

func TestErrorCodeNoInteractiveSession(t *testing.T) {
	if ErrorCode(capture.ErrNoInteractiveSession) != capture.CodeNoInteractiveSession {
		t.Fatal(ErrorCode(capture.ErrNoInteractiveSession))
	}
	if !IsNoInteractiveSession(capture.ErrNoInteractiveSession) {
		t.Fatal("IsNoInteractiveSession")
	}
	if IsNoInteractiveSession(errors.New("other")) {
		t.Fatal("other")
	}
	if ErrorCode(errors.New("boom")) != capture.CodeCaptureFailed {
		t.Fatal(ErrorCode(errors.New("boom")))
	}
	if ErrorCode(capture.ErrTimeout) != capture.CodeTimeout {
		t.Fatal(ErrorCode(capture.ErrTimeout))
	}
}
