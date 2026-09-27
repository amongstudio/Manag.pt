//go:build windows && !lite

package desktop

import (
	"fmt"
	"image"
	"runtime"
	"sync"
	"unsafe"

	"github.com/pc-manager/agent/internal/capture"
	"golang.org/x/sys/windows"
)

const (
	mfVersion                   = 0x00020070
	mfVideoInterlaceProgressive = 2
	hnsPerSecond                = 10_000_000
	mftOutputProvidesSamples    = 0x00000100
	mfETransformNeedMoreInput   = 0xC00D6D72
	mfENotAccepting             = 0xC00D36B5

	imfTransformGetOutputStreamInfo   = 7
	imfTransformGetInputAvailableType = 10
	imfTransformSetInputType          = 12
	imfTransformSetOutputType         = 13
	imfTransformGetInputCurrentType   = 14
	imfTransformProcessMessage        = 21
	imfTransformProcessInput          = 22
	imfTransformProcessOutput         = 23
)

var (
	// CLSID_CMSH264EncoderMFT from wmcodecdsp.h — not the widely copied F220A4F4 GUID.
	clsidCMSH264EncoderMFT    = windows.GUID{Data1: 0x6ca50344, Data2: 0x051a, Data3: 0x4ded, Data4: [8]byte{0x97, 0x79, 0xa4, 0x33, 0x05, 0x16, 0x5e, 0x35}}
	clsidCMSH264EncoderLegacy = windows.GUID{Data1: 0xf220a4f4, Data2: 0x8d24, Data3: 0x4d90, Data4: [8]byte{0xbd, 0xbc, 0xa2, 0xce, 0xfb, 0x8d, 0x27, 0xd1}}
	mftCategoryVideoEncoder   = windows.GUID{Data1: 0xf79eac7d, Data2: 0xe545, Data3: 0x4387, Data4: [8]byte{0xbd, 0xee, 0xd6, 0x47, 0xd7, 0xbd, 0xe4, 0x2a}}
	iidIMFTransform           = windows.GUID{Data1: 0xbf94c121, Data2: 0x5b05, Data3: 0x4c5d, Data4: [8]byte{0xae, 0x63, 0x0c, 0x06, 0x5d, 0xba, 0x0c, 0x4d}}
	iidIUnknown               = windows.GUID{Data1: 0x00000000, Data2: 0x0000, Data3: 0x0000, Data4: [8]byte{0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
	iidIClassFactory          = windows.GUID{Data1: 0x00000001, Data2: 0x0000, Data3: 0x0000, Data4: [8]byte{0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
	iidICodecAPI              = windows.GUID{Data1: 0x901db4c7, Data2: 0x31ce, Data3: 0x41a2, Data4: [8]byte{0x85, 0xdc, 0x8f, 0xa0, 0xbf, 0x41, 0xb8, 0xda}}

	mfMediaTypeVideo  = windows.GUID{Data1: 0x73646976, Data2: 0x0000, Data3: 0x0010, Data4: [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	mfVideoFormatH264 = windows.GUID{Data1: 0x34363248, Data2: 0x0000, Data3: 0x0010, Data4: [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	mfVideoFormatNV12 = windows.GUID{Data1: 0x3231564e, Data2: 0x0000, Data3: 0x0010, Data4: [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	mfVideoFormatI420 = windows.GUID{Data1: 0x30323449, Data2: 0x0000, Data3: 0x0010, Data4: [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	mfVideoFormatIYUV = windows.GUID{Data1: 0x56555949, Data2: 0x0000, Data3: 0x0010, Data4: [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}

	mfMTMajorType        = windows.GUID{Data1: 0x48eba18e, Data2: 0xf8c9, Data3: 0x4687, Data4: [8]byte{0xbf, 0x11, 0x0a, 0x74, 0xc9, 0xf9, 0x6a, 0x8f}}
	mfMTSubtype          = windows.GUID{Data1: 0xf7e34c9a, Data2: 0x42e8, Data3: 0x4714, Data4: [8]byte{0xb7, 0x4b, 0xcb, 0x29, 0xd7, 0x2c, 0x35, 0xe5}}
	mfMTAvgBitrate       = windows.GUID{Data1: 0x20332624, Data2: 0xfb0d, Data3: 0x4d9e, Data4: [8]byte{0xbd, 0x0d, 0xcb, 0xf6, 0x78, 0x6c, 0x10, 0x2e}}
	mfMTFrameRate        = windows.GUID{Data1: 0xc459a2e8, Data2: 0x3d2c, Data3: 0x4e44, Data4: [8]byte{0xb1, 0x32, 0xfe, 0xe5, 0x15, 0x6c, 0x7b, 0xb0}}
	mfMTFrameSize        = windows.GUID{Data1: 0x1652c33d, Data2: 0xd6b2, Data3: 0x4012, Data4: [8]byte{0xb8, 0x34, 0x72, 0x03, 0x08, 0x49, 0xa3, 0x7d}}
	mfMTInterlaceMode    = windows.GUID{Data1: 0xe2724bb8, Data2: 0xe676, Data3: 0x4806, Data4: [8]byte{0xb4, 0xb2, 0xa8, 0xd6, 0xef, 0xb4, 0x4c, 0xcd}}
	mfMTPixelAspectRatio = windows.GUID{Data1: 0xc6376a1e, Data2: 0x8d0a, Data3: 0x4027, Data4: [8]byte{0xbe, 0x45, 0x6d, 0x9a, 0x0a, 0xd3, 0x9b, 0xb6}}
	mfMTDefaultStride    = windows.GUID{Data1: 0x644b4e48, Data2: 0x1e02, Data3: 0x4516, Data4: [8]byte{0xb0, 0xeb, 0xc0, 0x1c, 0xa9, 0xd4, 0x9a, 0xc6}}
	mfMTMPEG2Profile     = windows.GUID{Data1: 0xad76a80b, Data2: 0x2d5c, Data3: 0x4e0b, Data4: [8]byte{0xb3, 0x75, 0x64, 0xe5, 0x20, 0x13, 0x70, 0x36}}

	codecAPILowLatency  = windows.GUID{Data1: 0x9c27891a, Data2: 0xed7a, Data3: 0x40e1, Data4: [8]byte{0x88, 0xe8, 0xb2, 0x27, 0x27, 0xa0, 0x24, 0xee}}
	codecAPIMeanBitRate = windows.GUID{Data1: 0xf7222374, Data2: 0x2144, Data3: 0x4815, Data4: [8]byte{0xb5, 0x50, 0xa3, 0x7d, 0xd6, 0x8e, 0x1d, 0xd7}}
	codecAPIRateControl = windows.GUID{Data1: 0x1c0608e9, Data2: 0x370c, Data3: 0x4710, Data4: [8]byte{0x8a, 0x58, 0xcb, 0x61, 0x81, 0xc4, 0x24, 0x23}}
	codecAPIGOPSize     = windows.GUID{Data1: 0x95f31b26, Data2: 0x95a4, Data3: 0x41aa, Data4: [8]byte{0x93, 0x03, 0x24, 0x6a, 0x7f, 0xc6, 0xee, 0xfb}}
)

var (
	mfOnce sync.Once
	mfErr  error
)

func h264Available() bool { return true }

func initMediaRuntime() error {
	_, err := coInit()
	if err != nil {
		return err
	}
	mfOnce.Do(func() {
		mfErr = callProc("MFStartup", procMFStartup, mfVersion, 0)
	})
	return mfErr
}

type mfH264 struct {
	xf              unsafe.Pointer
	writer          unsafe.Pointer
	w, h            int
	fps             int
	duration        int64
	time            int64
	input           windows.GUID
	providesSamples bool
	outSize         uint32
}

func (e *mfH264) Size() (int, int) { return e.w, e.h }

func (e *mfH264) Close() {
	if e == nil {
		return
	}
	if e.xf != nil {
		_ = callHR("ProcessMessage END_STREAMING", e.xf, imfTransformProcessMessage, 0x10000001, 0)
		release(e.xf)
		e.xf = nil
	}
	if e.writer != nil {
		_ = callHR("IMFSinkWriter.Finalize", e.writer, 11)
		release(e.writer)
		e.writer = nil
	}
}

func newH264Encoder(w, h, fps, bitrate int) (h264Encoder, error) {
	enc, err := newLocalH264Encoder(w, h, fps, bitrate)
	if err == nil {
		return enc, nil
	}
	if capture.SessionHelper() {
		if pipe, perr := newPipeH264Encoder(w, h, fps, bitrate); perr == nil {
			return pipe, nil
		}
	}
	return nil, err
}

func newLocalH264Encoder(w, h, fps, bitrate int) (*mfH264, error) {
	if err := initMediaRuntime(); err != nil {
		return nil, wrapH264Err(err)
	}
	w, h = evenSize(w), evenSize(h)
	if w < 16 || h < 16 {
		return nil, fmt.Errorf("frame too small: %dx%d", w, h)
	}
	if w > maxH264Width {
		return nil, fmt.Errorf("%s: %dx%d", codeFrameTooLarge, w, h)
	}
	if fps < 1 {
		fps = defaultFPS
	}
	if bitrate < 200_000 {
		bitrate = 200_000
	}
	cands := h264EncoderCandidates()
	var last error
	for i, xf := range cands {
		enc, err := initH264Encoder(xf, w, h, fps, bitrate)
		if err == nil {
			for _, extra := range cands[i+1:] {
				release(extra)
			}
			return enc, nil
		}
		last = err
		release(xf)
	}
	if xf, writer, err := sinkWriterTransform(w, h, fps, bitrate); err == nil {
		enc, ierr := initH264EncoderLocked(xf, w, h, fps, writer)
		if ierr == nil {
			return enc, nil
		}
		last = ierr
		release(xf)
		_ = callHR("IMFSinkWriter.Finalize", writer, 11)
		release(writer)
	} else if last == nil {
		last = err
	}
	if last == nil {
		if h264EncoderDLLPresent() || h264MFTListed() {
			last = fmt.Errorf("%s", codeMFTransformUnavailable)
		} else {
			last = fmt.Errorf("%s", codeMFClassMissing)
		}
	} else if h264ErrorCode(last) == codeMFClassMissing && (h264EncoderDLLPresent() || h264MFTListed()) {
		last = fmt.Errorf("%s", codeMFTransformUnavailable)
	}
	return nil, wrapH264Err(last)
}

func initH264Encoder(xf unsafe.Pointer, w, h, fps, bitrate int) (*mfH264, error) {
	configureH264CodecAPI(xf, uint32(bitrate), uint32(fps))
	input, err := setH264Types(xf, w, h, fps, bitrate)
	if err != nil {
		return nil, wrapH264Err(err)
	}
	var info struct {
		Flags     uint32
		Size      uint32
		Alignment uint32
	}
	if err := callHR("GetOutputStreamInfo", xf, imfTransformGetOutputStreamInfo, 0, uintptr(unsafe.Pointer(&info))); err != nil {
		return nil, wrapH264Err(err)
	}
	outSize := info.Size
	if outSize < 65536 {
		outSize = 65536
	}
	_ = callHR("ProcessMessage BEGIN_STREAMING", xf, imfTransformProcessMessage, 0x10000000, 0)
	_ = callHR("ProcessMessage START_OF_STREAM", xf, imfTransformProcessMessage, 0x10000003, 0)
	return &mfH264{
		xf:              xf,
		w:               w,
		h:               h,
		fps:             fps,
		duration:        hnsPerSecond / int64(fps),
		input:           input,
		providesSamples: info.Flags&mftOutputProvidesSamples != 0,
		outSize:         outSize,
	}, nil
}

func initH264EncoderLocked(xf unsafe.Pointer, w, h, fps int, writer unsafe.Pointer) (*mfH264, error) {
	var inMT unsafe.Pointer
	input := mfVideoFormatNV12
	if err := callHR("GetInputCurrentType", xf, imfTransformGetInputCurrentType, 0, uintptr(unsafe.Pointer(&inMT))); err == nil && inMT != nil {
		if sub, gerr := getGUID(inMT, mfMTSubtype); gerr == nil {
			input = sub
		}
		release(inMT)
	}
	var info struct {
		Flags     uint32
		Size      uint32
		Alignment uint32
	}
	if err := callHR("GetOutputStreamInfo", xf, imfTransformGetOutputStreamInfo, 0, uintptr(unsafe.Pointer(&info))); err != nil {
		return nil, wrapH264Err(err)
	}
	outSize := info.Size
	if outSize < 65536 {
		outSize = 65536
	}
	if fps < 1 {
		fps = defaultFPS
	}
	return &mfH264{
		xf:              xf,
		writer:          writer,
		w:               w,
		h:               h,
		fps:             fps,
		duration:        hnsPerSecond / int64(fps),
		input:           input,
		providesSamples: info.Flags&mftOutputProvidesSamples != 0,
		outSize:         outSize,
	}, nil
}

const (
	mftEnumFlagSyncMFT        = 0x00000001
	mftEnumFlagLocalMFT       = 0x00000010
	mftEnumFlagAll            = 0x0000003F
	mftEnumFlagSortAndFilter  = 0x00000040
	imfActivateActivateObject = 33
)

type mftRegisterTypeInfo struct {
	MajorType windows.GUID
	Subtype   windows.GUID
}

func h264EncoderCandidates() []unsafe.Pointer {
	var out []unsafe.Pointer
	if xf, err := loadH264FromDLL(); err == nil {
		out = append(out, xf)
	}
	if xf, err := coCreateTransform(clsidCMSH264EncoderMFT); err == nil {
		out = append(out, xf)
	}
	out = append(out, enumH264EncoderTransforms()...)
	if len(out) == 0 {
		if xf, err := coCreateTransform(clsidCMSH264EncoderLegacy); err == nil {
			out = append(out, xf)
		}
	}
	return out
}

func enumH264EncoderTransforms() []unsafe.Pointer {
	flagSets := []uint32{
		mftEnumFlagSyncMFT | mftEnumFlagSortAndFilter,
		mftEnumFlagAll,
		mftEnumFlagSyncMFT | mftEnumFlagLocalMFT | mftEnumFlagSortAndFilter,
	}
	for _, flags := range flagSets {
		if out := enumH264EncoderTransformsFlags(flags); len(out) > 0 {
			return out
		}
	}
	return nil
}

func enumH264EncoderTransformsFlags(flags uint32) []unsafe.Pointer {
	outType := mftRegisterTypeInfo{MajorType: mfMediaTypeVideo, Subtype: mfVideoFormatH264}
	var arr unsafe.Pointer
	var count uint32
	r, _, _ := procMFTEnumEx.Call(
		uintptr(unsafe.Pointer(&mftCategoryVideoEncoder)),
		uintptr(flags),
		0,
		uintptr(unsafe.Pointer(&outType)),
		uintptr(unsafe.Pointer(&arr)),
		uintptr(unsafe.Pointer(&count)),
	)
	if hresult("MFTEnumEx", r) != nil || count == 0 || arr == nil {
		return nil
	}
	defer coTaskMemFree(arr)
	ptrs := unsafe.Slice((*unsafe.Pointer)(arr), int(count))
	var out []unsafe.Pointer
	for _, act := range ptrs {
		if act == nil {
			continue
		}
		xf, err := activateMFT(act)
		release(act)
		if err == nil && xf != nil {
			out = append(out, xf)
		}
	}
	return out
}

func loadH264FromDLL() (unsafe.Pointer, error) {
	mod := windows.NewLazySystemDLL("mfh264enc.dll")
	if err := mod.Load(); err != nil {
		return nil, err
	}
	proc := mod.NewProc("DllGetClassObject")
	var factory unsafe.Pointer
	r, _, _ := proc.Call(
		uintptr(unsafe.Pointer(&clsidCMSH264EncoderMFT)),
		uintptr(unsafe.Pointer(&iidIClassFactory)),
		uintptr(unsafe.Pointer(&factory)),
	)
	if err := hresult("DllGetClassObject", r); err != nil {
		return nil, err
	}
	defer release(factory)
	var xf unsafe.Pointer
	if err := callHR("CreateInstance", factory, 3, 0, uintptr(unsafe.Pointer(&iidIUnknown)), uintptr(unsafe.Pointer(&xf))); err != nil {
		if err2 := callHR("CreateInstance", factory, 3, 0, uintptr(unsafe.Pointer(&iidIMFTransform)), uintptr(unsafe.Pointer(&xf))); err2 != nil {
			return nil, err
		}
		return xf, nil
	}
	tr, err := transformFromUnknown(xf)
	if err != nil {
		release(xf)
		return nil, err
	}
	if tr != xf {
		release(xf)
	}
	return tr, nil
}

func activateMFT(activate unsafe.Pointer) (unsafe.Pointer, error) {
	var unk unsafe.Pointer
	if err := callHR("ActivateObject", activate, imfActivateActivateObject, uintptr(unsafe.Pointer(&iidIUnknown)), uintptr(unsafe.Pointer(&unk))); err != nil {
		var ptr unsafe.Pointer
		if err2 := callHR("ActivateObject", activate, imfActivateActivateObject, uintptr(unsafe.Pointer(&iidIMFTransform)), uintptr(unsafe.Pointer(&ptr))); err2 != nil {
			return nil, err
		}
		return ptr, nil
	}
	xf, err := transformFromUnknown(unk)
	release(unk)
	if err != nil {
		return nil, err
	}
	return xf, nil
}

func configureH264CodecAPI(xf unsafe.Pointer, bitrate, fps uint32) {
	api, err := queryInterface(xf, iidICodecAPI)
	if err != nil {
		return
	}
	defer release(api)
	_ = codecSetBool(api, codecAPILowLatency, true)
	_ = codecSetU32(api, codecAPIRateControl, 1) // CBR
	_ = codecSetU32(api, codecAPIMeanBitRate, bitrate)
	if fps < 1 {
		fps = 1
	}
	_ = codecSetU32(api, codecAPIGOPSize, fps)
}

type variant struct {
	VT  uint16
	_   [3]uint16
	Val uint64
}

func codecSetU32(api unsafe.Pointer, key windows.GUID, v uint32) error {
	val := variant{VT: 19, Val: uint64(v)} // VT_UI4
	err := callHR("ICodecAPI.SetValue", api, 9, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&val)))
	runtime.KeepAlive(key)
	runtime.KeepAlive(val)
	return err
}

func codecSetBool(api unsafe.Pointer, key windows.GUID, v bool) error {
	var raw uint64
	if v {
		raw = 0xffff
	}
	val := variant{VT: 11, Val: raw} // VT_BOOL
	err := callHR("ICodecAPI.SetValue", api, 9, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&val)))
	runtime.KeepAlive(key)
	runtime.KeepAlive(val)
	return err
}

func setH264Types(xf unsafe.Pointer, w, h, fps, bitrate int) (windows.GUID, error) {
	outMT, err := createMediaType()
	if err != nil {
		return windows.GUID{}, err
	}
	defer release(outMT)
	if err := setGUID(outMT, mfMTMajorType, mfMediaTypeVideo); err != nil {
		return windows.GUID{}, err
	}
	if err := setGUID(outMT, mfMTSubtype, mfVideoFormatH264); err != nil {
		return windows.GUID{}, err
	}
	_ = setUINT32(outMT, mfMTAvgBitrate, uint32(bitrate))
	_ = setUINT32(outMT, mfMTInterlaceMode, mfVideoInterlaceProgressive)
	_ = setUINT64(outMT, mfMTFrameSize, packPair(uint32(w), uint32(h)))
	_ = setUINT64(outMT, mfMTFrameRate, packPair(uint32(fps), 1))
	_ = setUINT64(outMT, mfMTPixelAspectRatio, packPair(1, 1))
	_ = setUINT32(outMT, mfMTMPEG2Profile, 66) // Baseline
	if err := callHR("SetOutputType", xf, imfTransformSetOutputType, 0, uintptr(outMT), 0); err != nil {
		return windows.GUID{}, err
	}
	if sub, err := setH264InputFromAvailable(xf, w, h, fps); err == nil {
		return sub, nil
	}
	candidates := []windows.GUID{mfVideoFormatNV12, mfVideoFormatI420, mfVideoFormatIYUV}
	var last error
	for _, sub := range candidates {
		inMT, err := createMediaType()
		if err != nil {
			return windows.GUID{}, err
		}
		_ = setGUID(inMT, mfMTMajorType, mfMediaTypeVideo)
		_ = setGUID(inMT, mfMTSubtype, sub)
		_ = setUINT32(inMT, mfMTInterlaceMode, mfVideoInterlaceProgressive)
		_ = setUINT64(inMT, mfMTFrameSize, packPair(uint32(w), uint32(h)))
		_ = setUINT64(inMT, mfMTFrameRate, packPair(uint32(fps), 1))
		_ = setUINT64(inMT, mfMTPixelAspectRatio, packPair(1, 1))
		stride := uint32(w)
		if sub != mfVideoFormatNV12 && sub != mfVideoFormatI420 && sub != mfVideoFormatIYUV {
			stride = uint32(w * 4)
		}
		_ = setUINT32(inMT, mfMTDefaultStride, stride)
		err = callHR("SetInputType", xf, imfTransformSetInputType, 0, uintptr(inMT), 0)
		release(inMT)
		if err == nil {
			return sub, nil
		}
		last = err
	}
	if last == nil {
		last = fmt.Errorf("no accepted H.264 input type")
	}
	return windows.GUID{}, last
}

func setH264InputFromAvailable(xf unsafe.Pointer, w, h, fps int) (windows.GUID, error) {
	accepted := map[windows.GUID]bool{
		mfVideoFormatNV12: true,
		mfVideoFormatI420: true,
		mfVideoFormatIYUV: true,
	}
	for i := 0; i < 16; i++ {
		var mt unsafe.Pointer
		if err := callHR("GetInputAvailableType", xf, imfTransformGetInputAvailableType, 0, uintptr(i), uintptr(unsafe.Pointer(&mt))); err != nil {
			break
		}
		sub, _ := getGUID(mt, mfMTSubtype)
		if !accepted[sub] {
			release(mt)
			continue
		}
		_ = setUINT64(mt, mfMTFrameSize, packPair(uint32(w), uint32(h)))
		_ = setUINT64(mt, mfMTFrameRate, packPair(uint32(fps), 1))
		err := callHR("SetInputType", xf, imfTransformSetInputType, 0, uintptr(mt), 0)
		release(mt)
		if err == nil {
			return sub, nil
		}
	}
	return windows.GUID{}, fmt.Errorf("no advertised H.264 input type")
}

func h264EncoderDLLPresent() bool {
	mod := windows.NewLazySystemDLL("mfh264enc.dll")
	return mod.Load() == nil
}

func h264MFTListed() bool {
	outType := mftRegisterTypeInfo{MajorType: mfMediaTypeVideo, Subtype: mfVideoFormatH264}
	var arr unsafe.Pointer
	var count uint32
	r, _, _ := procMFTEnumEx.Call(
		uintptr(unsafe.Pointer(&mftCategoryVideoEncoder)),
		uintptr(uint32(mftEnumFlagAll)),
		0,
		uintptr(unsafe.Pointer(&outType)),
		uintptr(unsafe.Pointer(&arr)),
		uintptr(unsafe.Pointer(&count)),
	)
	if arr != nil {
		ptrs := unsafe.Slice((*unsafe.Pointer)(arr), int(count))
		for _, act := range ptrs {
			release(act)
		}
		coTaskMemFree(arr)
	}
	return hresult("MFTEnumEx", r) == nil && count > 0
}

type mftOutputDataBuffer struct {
	StreamID uint32
	_        uint32
	Sample   unsafe.Pointer
	Status   uint32
	_2       uint32
	Events   unsafe.Pointer
}

func (e *mfH264) drainOutput() ([]byte, error) {
	var out []byte
	for i := 0; i < 8; i++ {
		var provided unsafe.Pointer
		if !e.providesSamples {
			created, err := newEmptySample(int(e.outSize))
			if err != nil {
				return out, err
			}
			provided = created
		}
		buf := mftOutputDataBuffer{Sample: provided}
		var status uint32
		hr := syscallCOM(e.xf, imfTransformProcessOutput, 0, 1, uintptr(unsafe.Pointer(&buf)), uintptr(unsafe.Pointer(&status)))
		runtime.KeepAlive(buf)
		if uint32(hr) == mfETransformNeedMoreInput {
			if provided != nil {
				release(provided)
			}
			break
		}
		if err := hresult("ProcessOutput", hr); err != nil {
			if provided != nil && buf.Sample != provided {
				release(provided)
			}
			if buf.Sample != nil {
				release(buf.Sample)
			}
			if buf.Events != nil {
				release(buf.Events)
			}
			return out, err
		}
		if buf.Events != nil {
			release(buf.Events)
		}
		if buf.Sample != nil {
			raw, err := sampleBytes(buf.Sample)
			release(buf.Sample)
			if provided != nil && buf.Sample != provided {
				release(provided)
			}
			if err != nil {
				return out, err
			}
			if len(raw) > 0 {
				out = append(out, avccToAnnexB(raw)...)
			}
		} else if provided != nil {
			release(provided)
		}
	}
	return out, nil
}

func (e *mfH264) Encode(img image.Image) ([]byte, error) {
	if e == nil || e.xf == nil {
		return nil, fmt.Errorf("encoder closed")
	}
	var yuv []byte
	switch e.input {
	case mfVideoFormatI420, mfVideoFormatIYUV:
		yuv = imageToI420(img, e.w, e.h)
	default:
		yuv = imageToNV12(img, e.w, e.h)
	}
	sample, err := newVideoSample(yuv, e.time, e.duration)
	if err != nil {
		return nil, err
	}
	defer release(sample)
	hr := syscallCOM(e.xf, imfTransformProcessInput, 0, uintptr(sample), 0) // ProcessInput
	if uint32(hr) == mfENotAccepting {
		if _, drainErr := e.drainOutput(); drainErr != nil {
			return nil, drainErr
		}
		if err := callHR("ProcessInput", e.xf, imfTransformProcessInput, 0, uintptr(sample), 0); err != nil {
			return nil, err
		}
	} else if err := hresult("ProcessInput", hr); err != nil {
		return nil, err
	}
	e.time += e.duration
	return e.drainOutput()
}

func newEmptySample(size int) (unsafe.Pointer, error) {
	var buf unsafe.Pointer
	if err := callProc("MFCreateMemoryBuffer", procMFCreateMemoryBuffer, uintptr(size), uintptr(unsafe.Pointer(&buf))); err != nil {
		return nil, err
	}
	defer release(buf)
	if err := callHR("SetCurrentLength", buf, 6, 0); err != nil {
		return nil, err
	}
	var sample unsafe.Pointer
	if err := callProc("MFCreateSample", procMFCreateSample, uintptr(unsafe.Pointer(&sample))); err != nil {
		return nil, err
	}
	if err := callHR("AddBuffer", sample, 42, uintptr(buf)); err != nil {
		release(sample)
		return nil, err
	}
	return sample, nil
}

func newVideoSample(data []byte, start, duration int64) (unsafe.Pointer, error) {
	var buf unsafe.Pointer
	if err := callProc("MFCreateMemoryBuffer", procMFCreateMemoryBuffer, uintptr(len(data)), uintptr(unsafe.Pointer(&buf))); err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			release(buf)
		}
	}()
	var ptr *byte
	var max, cur uint32
	if err := callHR("Lock", buf, 3, uintptr(unsafe.Pointer(&ptr)), uintptr(unsafe.Pointer(&max)), uintptr(unsafe.Pointer(&cur))); err != nil {
		return nil, err
	}
	copy(unsafe.Slice(ptr, len(data)), data)
	_ = callHR("Unlock", buf, 4)
	if err := callHR("SetCurrentLength", buf, 6, uintptr(len(data))); err != nil {
		return nil, err
	}
	var sample unsafe.Pointer
	if err := callProc("MFCreateSample", procMFCreateSample, uintptr(unsafe.Pointer(&sample))); err != nil {
		return nil, err
	}
	if err := callHR("AddBuffer", sample, 42, uintptr(buf)); err != nil {
		release(sample)
		return nil, err
	}
	ok = true
	release(buf)
	_ = callHR("SetSampleTime", sample, 36, uintptr(start))
	_ = callHR("SetSampleDuration", sample, 38, uintptr(duration))
	return sample, nil
}

func sampleBytes(sample unsafe.Pointer) ([]byte, error) {
	var buf unsafe.Pointer
	if err := callHR("ConvertToContiguousBuffer", sample, 41, uintptr(unsafe.Pointer(&buf))); err != nil {
		return nil, err
	}
	defer release(buf)
	var ptr *byte
	var max, cur uint32
	if err := callHR("Lock", buf, 3, uintptr(unsafe.Pointer(&ptr)), uintptr(unsafe.Pointer(&max)), uintptr(unsafe.Pointer(&cur))); err != nil {
		return nil, err
	}
	defer func() { _ = callHR("Unlock", buf, 4) }()
	if cur == 0 || ptr == nil {
		return nil, nil
	}
	return append([]byte(nil), unsafe.Slice(ptr, int(cur))...), nil
}
