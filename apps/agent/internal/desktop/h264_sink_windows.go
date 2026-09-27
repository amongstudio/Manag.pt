//go:build windows && !lite

package desktop

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	iidIMFSinkWriterEx = windows.GUID{Data1: 0x588d72ab, Data2: 0x5bc1, Data3: 0x496a, Data4: [8]byte{0x87, 0x14, 0xb7, 0x06, 0x17, 0x14, 0x1b, 0x25}}

	mfReadWriteEnableHWTransforms = windows.GUID{Data1: 0xa634a91c, Data2: 0x822b, Data3: 0x41b2, Data4: [8]byte{0xa4, 0x5e, 0xcd, 0x80, 0xa8, 0x05, 0x9a, 0x46}}
	mfSinkWriterDisableThrottling = windows.GUID{Data1: 0x08b845d8, Data2: 0x2b74, Data3: 0x4afe, Data4: [8]byte{0x9d, 0x53, 0xbe, 0x16, 0xd2, 0xd5, 0xae, 0x4f}}
	mfTranscodeContainerType      = windows.GUID{Data1: 0x150ffcd0, Data2: 0x9b3a, Data3: 0x4e4a, Data4: [8]byte{0x9b, 0xbc, 0xf5, 0x7e, 0x9d, 0x53, 0xf8, 0x9a}}
	mfContainerMPEG4              = windows.GUID{Data1: 0xdc6cd05d, Data2: 0xb9d0, Data3: 0x40ef, Data4: [8]byte{0xbd, 0x35, 0x60, 0x10, 0x9b, 0xe1, 0x7e, 0x57}}
)

// sinkWriterTransform builds an H.264 pipeline through IMFSinkWriter (which
// applies field-of-use unlock and type negotiation) and returns the encoder
// IMFTransform. The caller must keep writer alive while using xf.
func sinkWriterTransform(w, h, fps, bitrate int) (xf, writer unsafe.Pointer, err error) {
	dir := os.TempDir()
	path := filepath.Join(dir, fmt.Sprintf("pcmgr-h264-%d.mp4", os.Getpid()))
	path16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, nil, err
	}
	attrs, err := createAttributes(4)
	if err != nil {
		return nil, nil, err
	}
	defer release(attrs)
	_ = setUINT32(attrs, mfReadWriteEnableHWTransforms, 1)
	_ = setUINT32(attrs, mfSinkWriterDisableThrottling, 1)
	_ = setGUID(attrs, mfTranscodeContainerType, mfContainerMPEG4)

	var sw unsafe.Pointer
	if err := callProc("MFCreateSinkWriterFromURL", procMFCreateSinkWriterFromURL,
		uintptr(unsafe.Pointer(path16)), 0, uintptr(attrs), uintptr(unsafe.Pointer(&sw))); err != nil {
		return nil, nil, err
	}
	ok := false
	defer func() {
		if !ok && sw != nil {
			_ = callHR("IMFSinkWriter.Finalize", sw, 11)
			release(sw)
			_ = os.Remove(path)
		}
	}()

	outMT, err := createMediaType()
	if err != nil {
		return nil, nil, err
	}
	_ = setGUID(outMT, mfMTMajorType, mfMediaTypeVideo)
	_ = setGUID(outMT, mfMTSubtype, mfVideoFormatH264)
	_ = setUINT32(outMT, mfMTAvgBitrate, uint32(bitrate))
	_ = setUINT32(outMT, mfMTInterlaceMode, mfVideoInterlaceProgressive)
	_ = setUINT64(outMT, mfMTFrameSize, packPair(uint32(w), uint32(h)))
	_ = setUINT64(outMT, mfMTFrameRate, packPair(uint32(fps), 1))
	_ = setUINT64(outMT, mfMTPixelAspectRatio, packPair(1, 1))
	_ = setUINT32(outMT, mfMTMPEG2Profile, 66)
	var stream uint32
	if err := callHR("AddStream", sw, 3, uintptr(outMT), uintptr(unsafe.Pointer(&stream))); err != nil {
		release(outMT)
		return nil, nil, err
	}
	release(outMT)

	inMT, err := createMediaType()
	if err != nil {
		return nil, nil, err
	}
	_ = setGUID(inMT, mfMTMajorType, mfMediaTypeVideo)
	_ = setGUID(inMT, mfMTSubtype, mfVideoFormatNV12)
	_ = setUINT32(inMT, mfMTInterlaceMode, mfVideoInterlaceProgressive)
	_ = setUINT64(inMT, mfMTFrameSize, packPair(uint32(w), uint32(h)))
	_ = setUINT64(inMT, mfMTFrameRate, packPair(uint32(fps), 1))
	_ = setUINT64(inMT, mfMTPixelAspectRatio, packPair(1, 1))
	_ = setUINT32(inMT, mfMTDefaultStride, uint32(w))
	if err := callHR("SetInputMediaType", sw, 4, uintptr(stream), uintptr(inMT), 0); err != nil {
		release(inMT)
		return nil, nil, err
	}
	release(inMT)

	if xf, err := sinkWriterEncoder(sw, stream); err == nil && xf != nil {
		ok = true
		return xf, sw, nil
	}
	if err := callHR("BeginWriting", sw, 5); err != nil {
		return nil, nil, err
	}
	xf, err = sinkWriterEncoder(sw, stream)
	if err != nil {
		return nil, nil, err
	}
	ok = true
	return xf, sw, nil
}

func sinkWriterEncoder(writer unsafe.Pointer, stream uint32) (unsafe.Pointer, error) {
	var guidNull windows.GUID
	var xf unsafe.Pointer
	err := callHR("GetServiceForStream", writer, 12, uintptr(stream), uintptr(unsafe.Pointer(&guidNull)), uintptr(unsafe.Pointer(&iidIMFTransform)), uintptr(unsafe.Pointer(&xf)))
	runtime.KeepAlive(guidNull)
	if err == nil && xf != nil {
		if tr, qerr := queryInterface(xf, iidIMFTransform); qerr == nil && tr != nil {
			if tr != xf {
				release(xf)
			}
			return tr, nil
		}
		release(xf)
		xf = nil
	}
	ex, err := queryInterface(writer, iidIMFSinkWriterEx)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", codeMFTransformUnavailable, err)
	}
	defer release(ex)
	var cat windows.GUID
	if err := callHR("GetTransformForStream", ex, 14, uintptr(stream), 0, uintptr(unsafe.Pointer(&cat)), uintptr(unsafe.Pointer(&xf))); err != nil {
		return nil, fmt.Errorf("%s: %w", codeMFTransformUnavailable, err)
	}
	if xf == nil {
		return nil, fmt.Errorf("%s", codeMFTransformUnavailable)
	}
	if tr, qerr := queryInterface(xf, iidIMFTransform); qerr != nil {
		release(xf)
		return nil, fmt.Errorf("%s: %w", codeMFTransformUnavailable, qerr)
	} else if tr != xf {
		release(xf)
		xf = tr
	}
	return xf, nil
}
