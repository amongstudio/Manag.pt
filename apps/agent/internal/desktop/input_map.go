//go:build !lite

package desktop

func pointerToAbsolute(nx, ny float64, dispX, dispY, dispW, dispH, virtX, virtY, virtW, virtH int) (int32, int32) {
	if dispW < 1 {
		dispW = 1
	}
	if dispH < 1 {
		dispH = 1
	}
	if virtW < 1 {
		virtW = 1
	}
	if virtH < 1 {
		virtH = 1
	}
	if nx < 0 {
		nx = 0
	} else if nx > 1 {
		nx = 1
	}
	if ny < 0 {
		ny = 0
	} else if ny > 1 {
		ny = 1
	}
	px := float64(dispX) + nx*float64(dispW)
	py := float64(dispY) + ny*float64(dispH)
	ax := (px - float64(virtX)) * 65535 / float64(virtW)
	ay := (py - float64(virtY)) * 65535 / float64(virtH)
	if ax < 0 {
		ax = 0
	} else if ax > 65535 {
		ax = 65535
	}
	if ay < 0 {
		ay = 0
	} else if ay > 65535 {
		ay = 65535
	}
	return int32(ax + 0.5), int32(ay + 0.5)
}
