//go:build !windows && !linux

package agentctl

import (
	"time"

	"github.com/kardianos/service"
)

type nopProgram struct{}

func (nopProgram) Start(service.Service) error { return nil }
func (nopProgram) Stop(service.Service) error  { return nil }

type otherCtl struct {
	svc service.Service
}

func newController(serviceName string) Controller {
	s, err := service.New(nopProgram{}, &service.Config{Name: serviceName})
	if err != nil {
		return errCtl{err: err}
	}
	return &otherCtl{svc: s}
}

type errCtl struct{ err error }

func (c errCtl) Status() (Status, error) { return StatusUnknown, c.err }
func (c errCtl) Start() error            { return c.err }
func (c errCtl) Stop() error             { return c.err }
func (c errCtl) Restart() error          { return c.err }

func (c *otherCtl) Status() (Status, error) {
	st, err := c.svc.Status()
	if err != nil {
		return StatusUnknown, err
	}
	switch st {
	case service.StatusRunning:
		return StatusRunning, nil
	case service.StatusStopped:
		return StatusStopped, nil
	default:
		return StatusUnknown, nil
	}
}

func (c *otherCtl) Start() error {
	st, err := c.Status()
	if err == nil && st == StatusRunning {
		return nil
	}
	return service.Control(c.svc, "start")
}

func (c *otherCtl) Stop() error {
	st, err := c.Status()
	if err == nil && st == StatusStopped {
		return nil
	}
	return service.Control(c.svc, "stop")
}

func (c *otherCtl) Restart() error {
	if err := c.Stop(); err != nil {
		return err
	}
	time.Sleep(time.Second)
	return c.Start()
}
