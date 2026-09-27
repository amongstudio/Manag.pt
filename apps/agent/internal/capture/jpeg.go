package capture

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
)

func encodeJPEG(img image.Image, quality int) ([]byte, error) {
	if img == nil {
		return nil, errors.New("empty capture")
	}
	src := ensureRGBA(img)
	if src == nil {
		return nil, errors.New("empty capture")
	}
	if quality <= 0 {
		quality = 70
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, src, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	if buf.Len() > maxJPEGBytes {
		buf.Reset()
		if err := jpeg.Encode(&buf, src, &jpeg.Options{Quality: 40}); err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

func decodeJPEG(data []byte) (image.Image, error) {
	if len(data) == 0 {
		return nil, errors.New("empty jpeg")
	}
	return jpeg.Decode(bytes.NewReader(data))
}

// ensureRGBA copies into *image.RGBA so jpeg.Encode uses the Pix fast path
// instead of image.At per pixel (bgraImage and most wrappers).
func ensureRGBA(img image.Image) *image.RGBA {
	if img == nil {
		return nil
	}
	if r, ok := img.(*image.RGBA); ok {
		return r
	}
	if b, ok := img.(*bgraImage); ok {
		return bgraToRGBA(b.pix, b.stride, b.w, b.h)
	}
	bds := img.Bounds()
	w, h := bds.Dx(), bds.Dy()
	if w < 1 || h < 1 {
		return nil
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		off := y * dst.Stride
		sy := bds.Min.Y + y
		for x := 0; x < w; x++ {
			r, g, b, a := img.At(bds.Min.X+x, sy).RGBA()
			i := off + x*4
			dst.Pix[i] = uint8(r >> 8)
			dst.Pix[i+1] = uint8(g >> 8)
			dst.Pix[i+2] = uint8(b >> 8)
			dst.Pix[i+3] = uint8(a >> 8)
		}
	}
	return dst
}

func bgraToRGBA(pix []byte, stride, w, h int) *image.RGBA {
	if w < 1 || h < 1 || len(pix) == 0 {
		return nil
	}
	if stride < w*4 {
		stride = w * 4
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		srcOff := y * stride
		dstOff := y * dst.Stride
		for x := 0; x < w; x++ {
			si := srcOff + x*4
			di := dstOff + x*4
			if si+3 >= len(pix) || di+3 >= len(dst.Pix) {
				break
			}
			dst.Pix[di+0] = pix[si+2]
			dst.Pix[di+1] = pix[si+1]
			dst.Pix[di+2] = pix[si+0]
			dst.Pix[di+3] = pix[si+3]
		}
	}
	return dst
}
