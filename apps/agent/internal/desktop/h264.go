//go:build !lite

package desktop

import (
	"encoding/binary"
	"errors"
	"image"
	"strings"

	"github.com/pc-manager/agent/internal/capture"
)

const (
	maxH264Width               = 1920
	h264SDPFmtpLine            = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
	codeMFClassMissing         = "mf_class_missing"
	codeMFTransformUnavailable = "mf_transform_unavailable"
	codeFrameTooLarge          = "frame_too_large"
	codeNoSession              = "no_interactive_session"
)

type h264Encoder interface {
	Encode(img image.Image) ([]byte, error)
	Close()
	Size() (int, int)
}

func evenSize(v int) int {
	if v < 2 {
		return 2
	}
	return v &^ 1
}

func h264CaptureMaxWidth(maxWidth int) int {
	if maxWidth <= 0 || maxWidth > maxH264Width {
		return maxH264Width
	}
	return maxWidth
}

func h264EncodeSize(w, h, maxWidth int) (int, int) {
	w, h = evenSize(w), evenSize(h)
	capW := evenSize(h264CaptureMaxWidth(maxWidth))
	if capW < 16 {
		capW = 16
	}
	if w > capW && w > 0 {
		h = evenSize(h * capW / w)
		w = capW
	}
	return w, h
}

func prepareH264Frame(img image.Image, maxWidth int) image.Image {
	if img == nil {
		return nil
	}
	b := img.Bounds()
	w, h := h264EncodeSize(b.Dx(), b.Dy(), maxWidth)
	if w == evenSize(b.Dx()) && h == evenSize(b.Dy()) {
		return img
	}
	return scaleImage(img, w, h)
}

func scaleImage(src image.Image, w, h int) image.Image {
	w, h = evenSize(w), evenSize(h)
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw < 1 || sh < 1 {
		return dst
	}
	for y := 0; y < h; y++ {
		sy := b.Min.Y + y*sh/h
		for x := 0; x < w; x++ {
			sx := b.Min.X + x*sw/w
			r, g, bl, a := src.At(sx, sy).RGBA()
			i := y*dst.Stride + x*4
			dst.Pix[i] = uint8(r >> 8)
			dst.Pix[i+1] = uint8(g >> 8)
			dst.Pix[i+2] = uint8(bl >> 8)
			dst.Pix[i+3] = uint8(a >> 8)
		}
	}
	return dst
}

func h264FallbackReason(encErr, capErr error) string {
	if encErr != nil {
		if code := h264ErrorCode(encErr); code != "" {
			return code
		}
		return encErr.Error()
	}
	if capErr != nil {
		if code := h264ErrorCode(capErr); code != "" {
			return code
		}
		return capErr.Error()
	}
	return "capture_failed"
}

func h264ErrorCode(err error) string {
	if err == nil {
		return ""
	}
	msg := strings.ToLower(err.Error())
	switch {
	case errors.Is(err, capture.ErrNoInteractiveSession) || strings.Contains(msg, codeNoSession):
		return codeNoSession
	case errors.Is(err, capture.ErrFrameTooLarge) || strings.Contains(msg, codeFrameTooLarge) || strings.Contains(msg, "frame too large"):
		return codeFrameTooLarge
	case strings.Contains(msg, codeMFTransformUnavailable) || strings.Contains(msg, "0x80004002") || strings.Contains(msg, "no such interface"):
		return codeMFTransformUnavailable
	case strings.Contains(msg, codeMFClassMissing) || strings.Contains(msg, "0x80040154") || strings.Contains(msg, "0x80040111") || strings.Contains(msg, "class not registered"):
		return codeMFClassMissing
	default:
		return ""
	}
}

func wrapH264Err(err error) error {
	if err == nil {
		return nil
	}
	if code := h264ErrorCode(err); code != "" {
		return errors.New(code)
	}
	return err
}

func bitrateFromQuality(quality int) int {
	q := clampInt(quality, 10, 90)
	return (400 + q*80) * 1000
}

func avccToAnnexB(in []byte) []byte {
	if len(in) >= 4 && in[0] == 0 && in[1] == 0 && (in[2] == 1 || (in[2] == 0 && in[3] == 1)) {
		return in
	}
	out := make([]byte, 0, len(in)+8)
	i := 0
	for i+4 <= len(in) {
		n := int(binary.BigEndian.Uint32(in[i : i+4]))
		i += 4
		if n < 0 || n > len(in)-i {
			return in
		}
		out = append(out, 0, 0, 0, 1)
		out = append(out, in[i:i+n]...)
		i += n
	}
	if len(out) == 0 {
		return in
	}
	return out
}

func imageRGB(src image.Image, x, y int) (r, g, b int) {
	bds := src.Bounds()
	if x < bds.Min.X {
		x = bds.Min.X
	}
	if y < bds.Min.Y {
		y = bds.Min.Y
	}
	if x >= bds.Max.X {
		x = bds.Max.X - 1
	}
	if y >= bds.Max.Y {
		y = bds.Max.Y - 1
	}
	rr, gg, bb, _ := src.At(x, y).RGBA()
	return int(rr >> 8), int(gg >> 8), int(bb >> 8)
}

func yuvBT601(r, g, b int) (y, u, v byte) {
	Y := (66*r+129*g+25*b+128)>>8 + 16
	U := (-38*r-74*g+112*b+128)>>8 + 128
	V := (112*r-94*g-18*b+128)>>8 + 128
	return clampByte(Y), clampByte(U), clampByte(V)
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

func imageToNV12(src image.Image, w, h int) []byte {
	if r, ok := src.(*image.RGBA); ok {
		return rgbaPixToYUV(r.Pix, r.Stride, w, h, true)
	}
	return imageToYUVAt(src, w, h, true)
}

func imageToI420(src image.Image, w, h int) []byte {
	if r, ok := src.(*image.RGBA); ok {
		return rgbaPixToYUV(r.Pix, r.Stride, w, h, false)
	}
	return imageToYUVAt(src, w, h, false)
}

func rgbaPixToYUV(pix []byte, stride, w, h int, nv12 bool) []byte {
	if w < 2 {
		w = 2
	}
	if h < 2 {
		h = 2
	}
	w &^= 1
	h &^= 1
	dst := make([]byte, w*h+w*h/2)
	for y := 0; y < h; y++ {
		row := y * stride
		for x := 0; x < w; x++ {
			i := row + x*4
			r, g, b := 0, 0, 0
			if i+2 < len(pix) {
				r, g, b = int(pix[i]), int(pix[i+1]), int(pix[i+2])
			}
			Y, _, _ := yuvBT601(r, g, b)
			dst[y*w+x] = Y
		}
	}
	ys, us := w*h, w*h+w*h/4
	uv := dst[ys:]
	for y := 0; y < h; y += 2 {
		row := y * stride
		for x := 0; x < w; x += 2 {
			i := row + x*4
			r, g, b := 0, 0, 0
			if i+2 < len(pix) {
				r, g, b = int(pix[i]), int(pix[i+1]), int(pix[i+2])
			}
			_, U, V := yuvBT601(r, g, b)
			if nv12 {
				off := (y/2)*w + x
				uv[off] = U
				uv[off+1] = V
			} else {
				dst[ys+(y/2)*(w/2)+x/2] = U
				dst[us+(y/2)*(w/2)+x/2] = V
			}
		}
	}
	return dst
}

func imageToYUVAt(src image.Image, w, h int, nv12 bool) []byte {
	if w < 2 {
		w = 2
	}
	if h < 2 {
		h = 2
	}
	w &^= 1
	h &^= 1
	dst := make([]byte, w*h+w*h/2)
	bds := src.Bounds()
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r, g, b := imageRGB(src, bds.Min.X+x, bds.Min.Y+y)
			Y, _, _ := yuvBT601(r, g, b)
			dst[y*w+x] = Y
		}
	}
	ys, us := w*h, w*h+w*h/4
	uv := dst[ys:]
	for y := 0; y < h; y += 2 {
		for x := 0; x < w; x += 2 {
			r, g, b := imageRGB(src, bds.Min.X+x, bds.Min.Y+y)
			_, U, V := yuvBT601(r, g, b)
			if nv12 {
				off := (y/2)*w + x
				uv[off] = U
				uv[off+1] = V
			} else {
				dst[ys+(y/2)*(w/2)+x/2] = U
				dst[us+(y/2)*(w/2)+x/2] = V
			}
		}
	}
	return dst
}
