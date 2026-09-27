package agentctl

import (
	"context"
	"time"
)

type Status int

const (
	StatusUnknown Status = iota
	StatusStopped
	StatusRunning
	StatusStartPending
)

// Controller starts/stops/restarts the agent OS service. It does not run
// agent commands or talk to the fleet API.
type Controller interface {
	Status() (Status, error)
	Start() error
	Stop() error
	Restart() error
}

func New(serviceName string) Controller {
	return newController(serviceName)
}

func waitUntil(timeout time.Duration, ok func() bool) error {
	return waitUntilCtx(context.Background(), timeout, ok)
}

func waitUntilCtx(ctx context.Context, timeout time.Duration, ok func() bool) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		if ok() {
			return nil
		}
		select {
		case <-ctx.Done():
			return errTimeout
		case <-time.After(200 * time.Millisecond):
		}
	}
}

type timeoutError struct{}

func (timeoutError) Error() string { return "timeout waiting for service state" }

var errTimeout error = timeoutError{}
