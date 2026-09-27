//go:build windows

package tray

import (
	"testing"

	"github.com/lxn/win"
	"github.com/pc-manager/agent/internal/notify"
)

func TestBalloonFlags(t *testing.T) {
	if balloonFlags(notify.KindWSDown) != win.NIIF_WARNING {
		t.Fatal("ws_down")
	}
	if balloonFlags(notify.KindAgentRecovering) != win.NIIF_WARNING {
		t.Fatal("recovering")
	}
	if balloonFlags(notify.KindDesktopIncoming) != win.NIIF_INFO {
		t.Fatal("desktop")
	}
	if balloonFlags(notify.KindEnrolled) != win.NIIF_INFO {
		t.Fatal("enrolled")
	}
}
