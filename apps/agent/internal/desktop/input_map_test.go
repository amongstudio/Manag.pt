//go:build !lite

package desktop

import "testing"

func TestPointerToAbsolutePrimaryCenter(t *testing.T) {
	x, y := pointerToAbsolute(0.5, 0.5, 0, 0, 1920, 1080, 0, 0, 1920, 1080)
	if x < 32767 || x > 32768 || y < 32767 || y > 32768 {
		t.Fatalf("center got %d,%d", x, y)
	}
}

func TestPointerToAbsoluteSecondDisplayOrigin(t *testing.T) {
	x, y := pointerToAbsolute(0, 0, 1920, 0, 1920, 1080, 0, 0, 3840, 1080)
	if x < 32767 || x > 32768 {
		t.Fatalf("second display origin x=%d want ~32768", x)
	}
	if y != 0 {
		t.Fatalf("y=%d", y)
	}
}

func TestPointerToAbsoluteClamps(t *testing.T) {
	x, y := pointerToAbsolute(-1, 2, 0, 0, 100, 100, 0, 0, 100, 100)
	if x != 0 || y != 65535 {
		t.Fatalf("clamped %d,%d", x, y)
	}
}
