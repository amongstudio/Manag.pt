//go:build windows

package recovery

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc/mgr"
)

func Apply(serviceName string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("open %s: %w", serviceName, err)
	}
	defer s.Close()
	actions := []mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
	}
	if err := s.SetRecoveryActions(actions, 86400); err != nil {
		return err
	}
	return s.SetRecoveryActionsOnNonCrashFailures(true)
}
