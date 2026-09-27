package capture

import (
	"errors"
	"fmt"
	"image"
	"image/color"
	"strings"
)

const (
	CodeNoInteractiveSession = "no_interactive_session"
	CodeCaptureFailed        = "capture_failed"
	CodeTimeout              = "capture_timeout"
	CodeFrameTooLarge        = "frame_too_large"

	maxJPEGBytes = 8 << 20
)

var (
	ErrNoInteractiveSession = errors.New(CodeNoInteractiveSession)
	ErrTimeout              = errors.New("capture timeout")
	ErrUnsupported          = errors.New("unsupported")
	ErrBlackFrame           = errors.New("black frame")
	ErrHelperTimeout        = errors.New("capture-helper timeout")
	ErrFrameTooLarge        = errors.New(CodeFrameTooLarge)
)

// helperMode is set by capture-helper so the child never spawns another helper.
var helperMode bool

type DisplayInfo struct {
	ID     int `json:"id"`
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

type Clip struct {
	Kind  string
	Text  string
	HTML  string
	Files []string
	Mime  string
	Image []byte
}

type Frame struct {
	Width  int
	Height int
	Stride int
	Pix    []byte // BGRA
	NV12   []byte
	JPEG   []byte
	Format string
	img    image.Image
}

func (f *Frame) Image() image.Image {
	if f == nil {
		return nil
	}
	if f.img != nil {
		return ensureRGBA(f.img)
	}
	if len(f.NV12) > 0 && f.Width > 0 && f.Height > 0 {
		return nv12ToRGBA(f.NV12, f.Width, f.Height)
	}
	if len(f.Pix) == 0 || f.Width < 1 || f.Height < 1 {
		return nil
	}
	stride := f.Stride
	if stride < f.Width*4 {
		stride = f.Width * 4
	}
	return bgraToRGBA(f.Pix, stride, f.Width, f.Height)
}

type bgraImage struct {
	pix    []byte
	stride int
	w, h   int
}

func (b *bgraImage) ColorModel() color.Model { return color.RGBAModel }
func (b *bgraImage) Bounds() image.Rectangle { return image.Rect(0, 0, b.w, b.h) }
func (b *bgraImage) At(x, y int) color.Color {
	if x < 0 || y < 0 || x >= b.w || y >= b.h {
		return color.RGBA{}
	}
	i := y*b.stride + x*4
	if i+3 >= len(b.pix) {
		return color.RGBA{}
	}
	return color.RGBA{R: b.pix[i+2], G: b.pix[i+1], B: b.pix[i], A: b.pix[i+3]}
}

func ErrorCode(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, ErrNoInteractiveSession) {
		return CodeNoInteractiveSession
	}
	if errors.Is(err, ErrTimeout) {
		return CodeTimeout
	}
	if errors.Is(err, ErrFrameTooLarge) {
		return CodeFrameTooLarge
	}
	if code := strings.TrimSpace(err.Error()); code == CodeNoInteractiveSession {
		return CodeNoInteractiveSession
	}
	if code := strings.TrimSpace(err.Error()); code == CodeFrameTooLarge {
		return CodeFrameTooLarge
	}
	return CodeCaptureFailed
}

func WrapNoSession(err error) error {
	if err == nil {
		return ErrNoInteractiveSession
	}
	if errors.Is(err, ErrNoInteractiveSession) {
		return err
	}
	return fmt.Errorf("%w: %v", ErrNoInteractiveSession, err)
}

func ParsePipeArg(args []string) string {
	for i, a := range args {
		if a == "--pipe" && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(a, "--pipe=") {
			return strings.TrimPrefix(a, "--pipe=")
		}
	}
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		return args[0]
	}
	return ""
}

func isMostlyBlack(pix []byte, stride, w, h int) bool {
	if w < 1 || h < 1 || len(pix) == 0 {
		return true
	}
	checked, nonzero := 0, 0
	for y := 0; y < h; y += 8 {
		row := y * stride
		for x := 0; x < w; x += 16 {
			o := row + x*4
			if o+2 >= len(pix) {
				break
			}
			if pix[o] != 0 || pix[o+1] != 0 || pix[o+2] != 0 {
				nonzero++
			}
			checked++
		}
	}
	if checked == 0 {
		return true
	}
	return nonzero*100 < checked
}

func evenDim(v int) int {
	if v < 2 {
		return 2
	}
	return v &^ 1
}

func scaleWH(srcW, srcH, maxWidth int) (int, int) {
	if srcW < 1 {
		srcW = 1
	}
	if srcH < 1 {
		srcH = 1
	}
	if maxWidth <= 0 || srcW <= maxWidth {
		return srcW, srcH
	}
	dstH := srcH * maxWidth / srcW
	if dstH < 1 {
		dstH = 1
	}
	return maxWidth, dstH
}

func pipeBodyLen(format string, w, h int) int {
	switch format {
	case formatNV12:
		w, h = evenDim(w), evenDim(h)
		return w*h + w*h/2
	case formatBGRA:
		return w * h * 4
	default:
		return 0
	}
}

func maxWidthFittingPipe(srcW, srcH, maxWidth int, format string) int {
	w, h := scaleWH(srcW, srcH, maxWidth)
	if format != formatBGRA && format != formatNV12 {
		return w
	}
	if pipeBodyLen(format, w, h) <= maxBodyBytes {
		return w
	}
	lo, hi := 16, w
	best := 16
	for lo <= hi {
		mid := (lo + hi) / 2
		mw, mh := scaleWH(srcW, srcH, mid)
		if pipeBodyLen(format, mw, mh) <= maxBodyBytes {
			best = mw
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	return best
}

func clampByte(v int) byte {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return byte(v)
}

func yuvBT601(r, g, b int) (y, u, v byte) {
	Y := (66*r+129*g+25*b+128)>>8 + 16
	U := (-38*r-74*g+112*b+128)>>8 + 128
	V := (112*r-94*g-18*b+128)>>8 + 128
	return clampByte(Y), clampByte(U), clampByte(V)
}

func bgraToNV12(pix []byte, stride, w, h int) []byte {
	w, h = evenDim(w), evenDim(h)
	if stride < w*4 {
		stride = w * 4
	}
	dst := make([]byte, w*h+w*h/2)
	for y := 0; y < h; y++ {
		row := y * stride
		for x := 0; x < w; x++ {
			i := row + x*4
			b, g, r := 0, 0, 0
			if i+2 < len(pix) {
				b, g, r = int(pix[i]), int(pix[i+1]), int(pix[i+2])
			}
			Y, _, _ := yuvBT601(r, g, b)
			dst[y*w+x] = Y
		}
	}
	uv := dst[w*h:]
	for y := 0; y < h; y += 2 {
		row := y * stride
		for x := 0; x < w; x += 2 {
			i := row + x*4
			b, g, r := 0, 0, 0
			if i+2 < len(pix) {
				b, g, r = int(pix[i]), int(pix[i+1]), int(pix[i+2])
			}
			_, U, V := yuvBT601(r, g, b)
			off := (y/2)*w + x
			uv[off] = U
			uv[off+1] = V
		}
	}
	return dst
}

func nv12ToRGBA(nv12 []byte, w, h int) *image.RGBA {
	w, h = evenDim(w), evenDim(h)
	need := w*h + w*h/2
	if w < 1 || h < 1 || len(nv12) < need {
		return nil
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	uv := nv12[w*h:]
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			Y := int(nv12[y*w+x])
			off := (y/2)*w + (x &^ 1)
			U := int(uv[off])
			V := int(uv[off+1])
			C := Y - 16
			D := U - 128
			E := V - 128
			r := (298*C + 409*E + 128) >> 8
			g := (298*C - 100*D - 208*E + 128) >> 8
			b := (298*C + 516*D + 128) >> 8
			i := y*dst.Stride + x*4
			dst.Pix[i] = clampByte(r)
			dst.Pix[i+1] = clampByte(g)
			dst.Pix[i+2] = clampByte(b)
			dst.Pix[i+3] = 255
		}
	}
	return dst
}
