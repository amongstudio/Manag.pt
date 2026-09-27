//go:build windows

package agentctl

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

type windowsCtl struct {
	name string
}

func newController(serviceName string) Controller {
	return &windowsCtl{name: serviceName}
}

func (c *windowsCtl) withService(fn func(*mgr.Service) error) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(c.name)
	if err != nil {
		return fmt.Errorf("open agent service %q: %w", c.name, err)
	}
	defer s.Close()
	return fn(s)
}

func (c *windowsCtl) Status() (Status, error) {
	var st Status
	err := c.withService(func(s *mgr.Service) error {
		q, err := s.Query()
		if err != nil {
			return err
		}
		switch q.State {
		case svc.Stopped:
			st = StatusStopped
		case svc.StartPending, svc.Running, svc.ContinuePending:
			st = StatusRunning
		default:
			st = StatusUnknown
		}
		return nil
	})
	if err != nil {
		return StatusUnknown, err
	}
	return st, nil
}

func (c *windowsCtl) Start() error {
	return c.withService(func(s *mgr.Service) error {
		q, err := s.Query()
		if err != nil {
			return err
		}
		if q.State == svc.Running || q.State == svc.StartPending {
			return nil
		}
		if err := s.Start(); err != nil {
			return err
		}
		return waitUntil(30*time.Second, func() bool {
			q, err := s.Query()
			return err == nil && (q.State == svc.Running || q.State == svc.StartPending)
		})
	})
}

func (c *windowsCtl) Stop() error {
	return c.withService(func(s *mgr.Service) error {
		q, err := s.Query()
		if err != nil {
			return err
		}
		if q.State == svc.Stopped {
			return nil
		}
		if _, err := s.Control(svc.Stop); err != nil {
			q, qerr := s.Query()
			if qerr == nil && q.State == svc.Stopped {
				return nil
			}
			return err
		}
		return waitUntil(30*time.Second, func() bool {
			q, err := s.Query()
			return err == nil && q.State == svc.Stopped
		})
	})
}

func (c *windowsCtl) Restart() error {
	if err := c.Stop(); err != nil {
		return err
	}
	time.Sleep(time.Second)
	return c.Start()
}
