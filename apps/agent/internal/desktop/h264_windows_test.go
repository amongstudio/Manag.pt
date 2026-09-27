//go:build windows && !lite

package desktop

import (
	"image"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestIMFTransformVtableSlots(t *testing.T) {
	if imfTransformSetInputType != 12 || imfTransformSetOutputType != 13 {
		t.Fatalf("SetInputType=%d SetOutputType=%d", imfTransformSetInputType, imfTransformSetOutputType)
	}
	if imfTransformProcessMessage != 21 || imfTransformProcessInput != 22 || imfTransformProcessOutput != 23 {
		t.Fatalf("ProcessMessage=%d ProcessInput=%d ProcessOutput=%d", imfTransformProcessMessage, imfTransformProcessInput, imfTransformProcessOutput)
	}
}

func TestDocumentedH264EncoderCLSID(t *testing.T) {
	if clsidCMSH264EncoderMFT.Data1 != 0x6ca50344 {
		t.Fatalf("CLSID_CMSH264EncoderMFT Data1=%08x want 6ca50344 (wmcodecdsp.h)", clsidCMSH264EncoderMFT.Data1)
	}
	if clsidCMSH264EncoderMFT.Data1 == 0xf220a4f4 {
		t.Fatal("widely copied wrong H.264 encoder CLSID")
	}
}

func TestIMFTransformIID(t *testing.T) {
	parsed, err := windows.GUIDFromString("{bf94c121-5b05-4c5d-ae63-0c065dba0c4d}")
	if err != nil {
		t.Fatal(err)
	}
	if parsed != iidIMFTransform {
		t.Fatalf("iidIMFTransform %+v != SDK %+v", iidIMFTransform, parsed)
	}
}

func TestCoCreateMicrosoftH264Encoder(t *testing.T) {
	if err := initMediaRuntime(); err != nil {
		t.Skip(err)
	}
	unk, err := coCreate(clsidCMSH264EncoderMFT, iidIUnknown)
	if err != nil {
		msg := strings.ToLower(err.Error())
		if strings.Contains(msg, "0x80040154") || strings.Contains(msg, "0x80040111") {
			t.Skip("H.264 encoder CLSID is not registered (Windows N without Media Feature Pack)")
		}
		t.Fatalf("CoCreate IUnknown: %v", err)
	}
	defer release(unk)
	if _, err := queryInterface(unk, iidICodecAPI); err != nil {
		t.Fatalf("encoder object missing ICodecAPI: %v", err)
	}
	if _, err := transformFromUnknown(unk); err != nil {
		t.Skip("H.264 encoder COM object exists (ICodecAPI) but IMFTransform is not exposed on this SKU")
	}
}

func TestNewH264Encoder(t *testing.T) {
	enc, err := newH264Encoder(320, 180, 5, 500_000)
	if err != nil {
		t.Log(err)
		if h264ErrorCode(err) != codeMFClassMissing && h264ErrorCode(err) != codeMFTransformUnavailable {
			t.Fatalf("unexpected encoder error %q", err)
		}
		t.Skip("H.264 IMFTransform is unavailable; JPEG fallback is used")
	}
	img := imageRGBA(32, 18)
	nals, err := enc.Encode(img)
	enc.Close()
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(nals) == 0 {
		t.Fatal("no NALs")
	}
}

func imageRGBA(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = 40, 80, 160, 255
	}
	return img
}
