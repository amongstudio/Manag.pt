//go:build windows && !lite

package desktop

import (
	"encoding/binary"
	"fmt"
	"math"
	"time"
	"unsafe"

	"github.com/pc-manager/agent/internal/winsession"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/thesyncim/gopus"
	"golang.org/x/sys/windows"
)

const (
	audclntSharemodeShared     = 0
	audclntStreamflagsLoopback = 0x00020000
	audclntBufferflagsSilent   = 0x1
	eRender                    = 0
	eConsole                   = 0
	waveFormatPCM              = 1
	waveFormatIEEEFloat        = 3
	waveFormatExtensible       = 0xFFFE
	opusSampleRate             = 48000
	opusChannels               = 2
	opusFrameSamples           = 960 // 20 ms
	opusBitrate                = 64000
)

var (
	clsidMMDeviceEnumerator = windows.GUID{Data1: 0xbcde0395, Data2: 0xe52f, Data3: 0x467c, Data4: [8]byte{0x8e, 0x3d, 0xc4, 0x57, 0x92, 0x91, 0x69, 0x2e}}
	iidIMMDeviceEnumerator  = windows.GUID{Data1: 0xa95664d2, Data2: 0x9614, Data3: 0x4f35, Data4: [8]byte{0xa7, 0x46, 0xde, 0x8d, 0xb6, 0x36, 0x17, 0xe6}}
	iidIAudioClient         = windows.GUID{Data1: 0x1cb9ad4c, Data2: 0xdbfa, Data3: 0x4c32, Data4: [8]byte{0xb1, 0x78, 0xc2, 0xf5, 0x68, 0xa7, 0x03, 0xb2}}
	iidIAudioCaptureClient  = windows.GUID{Data1: 0xc8adbd64, Data2: 0xe71e, Data3: 0x48a0, Data4: [8]byte{0xa4, 0xde, 0x18, 0x5c, 0x39, 0x5c, 0xd3, 0x17}}
	ksDataSubtypeFloat      = windows.GUID{Data1: 0x00000003, Data2: 0x0000, Data3: 0x0010, Data4: [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
)

func audioAvailable() bool { return !winsession.InSession0() }

func startLoopbackAudio(track *webrtc.TrackLocalStaticSample, stop <-chan struct{}, onStatus func(bool, string)) error {
	if track == nil {
		return fmt.Errorf("audio track is nil")
	}
	go func() {
		if err := loopbackMain(track, stop); err != nil {
			if onStatus != nil {
				onStatus(false, err.Error())
			}
			return
		}
	}()
	return nil
}

type waveFormatEx struct {
	FormatTag      uint16
	Channels       uint16
	SamplesPerSec  uint32
	AvgBytesPerSec uint32
	BlockAlign     uint16
	BitsPerSample  uint16
	ExtraSize      uint16
}

func loopbackMain(track *webrtc.TrackLocalStaticSample, stop <-chan struct{}) error {
	cleanup, err := coInit()
	if err != nil {
		return err
	}
	defer cleanup()

	enum, err := coCreate(clsidMMDeviceEnumerator, iidIMMDeviceEnumerator)
	if err != nil {
		return fmt.Errorf("MMDeviceEnumerator: %w", err)
	}
	defer release(enum)

	var device unsafe.Pointer
	if err := callHR("GetDefaultAudioEndpoint", enum, 4, eRender, eConsole, uintptr(unsafe.Pointer(&device))); err != nil {
		return fmt.Errorf("default render endpoint: %w", err)
	}
	defer release(device)

	var client unsafe.Pointer
	if err := callHR("Activate", device, 3, uintptr(unsafe.Pointer(&iidIAudioClient)), 23, 0, uintptr(unsafe.Pointer(&client))); err != nil {
		return fmt.Errorf("IAudioClient: %w", err)
	}
	defer release(client)

	var mix unsafe.Pointer
	if err := callHR("GetMixFormat", client, 8, uintptr(unsafe.Pointer(&mix))); err != nil {
		return fmt.Errorf("mix format: %w", err)
	}
	defer procCoTaskMemFree.Call(uintptr(mix))

	fmtx := parseMix(mix)
	hnsBuffer := int64(1_000_000) // 100 ms
	if err := callHR("Initialize", client, 3, audclntSharemodeShared, audclntStreamflagsLoopback, uintptr(hnsBuffer), 0, uintptr(mix), 0); err != nil {
		return fmt.Errorf("WASAPI loopback init: %w", err)
	}

	var capture unsafe.Pointer
	if err := callHR("GetService", client, 14, uintptr(unsafe.Pointer(&iidIAudioCaptureClient)), uintptr(unsafe.Pointer(&capture))); err != nil {
		return fmt.Errorf("IAudioCaptureClient: %w", err)
	}
	defer release(capture)

	enc, err := gopus.NewEncoder(gopus.EncoderConfig{
		SampleRate:  opusSampleRate,
		Channels:    opusChannels,
		Application: gopus.ApplicationAudio,
	})
	if err != nil {
		return fmt.Errorf("opus encoder: %w", err)
	}
	_ = enc.SetBitrate(opusBitrate)

	if err := callHR("Start", client, 10); err != nil {
		return fmt.Errorf("WASAPI start: %w", err)
	}
	defer func() { _ = callHR("Stop", client, 11) }()

	pcm := make([]int16, 0, opusFrameSamples*opusChannels*4)
	packet := make([]byte, 4000)
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-stop:
			return nil
		case <-ticker.C:
			frames := drainCapture(capture, fmtx, &pcm)
			_ = frames
			for len(pcm) >= opusFrameSamples*opusChannels {
				frame := pcm[:opusFrameSamples*opusChannels]
				n, encErr := enc.EncodeInt16(frame, packet)
				pcm = pcm[opusFrameSamples*opusChannels:]
				if encErr != nil || n <= 0 {
					continue
				}
				_ = track.WriteSample(media.Sample{Data: append([]byte(nil), packet[:n]...), Duration: 20 * time.Millisecond})
			}
		}
	}
}

func drainCapture(capture unsafe.Pointer, fmtx capturedFormat, pcm *[]int16) int {
	total := 0
	for {
		var next uint32
		if err := callHR("GetNextPacketSize", capture, 5, uintptr(unsafe.Pointer(&next))); err != nil || next == 0 {
			return total
		}
		var data *byte
		var nFrames, flags uint32
		hr := syscallCOM(capture, 3, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&nFrames)), uintptr(unsafe.Pointer(&flags)), 0, 0)
		if int32(hr) < 0 || nFrames == 0 {
			return total
		}
		if flags&audclntBufferflagsSilent != 0 || data == nil {
			*pcm = appendSilence(*pcm, int(nFrames), fmtx)
		} else {
			*pcm = appendMixPCM(*pcm, unsafe.Slice(data, int(nFrames)*int(fmtx.BlockAlign)), fmtx)
		}
		_ = callHR("ReleaseBuffer", capture, 4, uintptr(nFrames))
		total += int(nFrames)
	}
}

func parseMix(mix unsafe.Pointer) capturedFormat {
	fmtx := *(*waveFormatEx)(mix)
	isFloat := fmtx.FormatTag == waveFormatIEEEFloat
	if fmtx.FormatTag == waveFormatExtensible {
		g := *(*windows.GUID)(unsafe.Add(mix, 24))
		if g == ksDataSubtypeFloat {
			isFloat = true
		}
	}
	return capturedFormat{waveFormatEx: fmtx, isFloat: isFloat}
}

type capturedFormat struct {
	waveFormatEx
	isFloat bool
}

func appendSilence(dst []int16, frames int, fmtx capturedFormat) []int16 {
	srcRate := int(fmtx.SamplesPerSec)
	if srcRate < 1 {
		srcRate = opusSampleRate
	}
	outFrames := frames * opusSampleRate / srcRate
	need := outFrames * opusChannels
	return append(dst, make([]int16, need)...)
}

func appendMixPCM(dst []int16, raw []byte, fmtx capturedFormat) []int16 {
	srcCh := int(fmtx.Channels)
	if srcCh < 1 {
		srcCh = 1
	}
	srcRate := int(fmtx.SamplesPerSec)
	if srcRate < 1 {
		srcRate = opusSampleRate
	}
	frameSize := int(fmtx.BlockAlign)
	if frameSize < 1 {
		return dst
	}
	nFrames := len(raw) / frameSize
	monoOrStereo := make([]int16, 0, nFrames*opusChannels)
	for i := 0; i < nFrames; i++ {
		off := i * frameSize
		l, r := samplePair(raw[off:], srcCh, int(fmtx.BitsPerSample), fmtx.isFloat)
		monoOrStereo = append(monoOrStereo, l, r)
	}
	if srcRate == opusSampleRate {
		return append(dst, monoOrStereo...)
	}
	return append(dst, resampleStereo(monoOrStereo, srcRate, opusSampleRate)...)
}

func samplePair(frame []byte, channels, bits int, isFloat bool) (int16, int16) {
	read := func(idx int) int16 {
		if isFloat {
			off := idx * 4
			if off+4 > len(frame) {
				return 0
			}
			bits32 := binary.LittleEndian.Uint32(frame[off : off+4])
			f := math.Float32frombits(bits32)
			if f > 1 {
				f = 1
			} else if f < -1 {
				f = -1
			}
			return int16(f * 32767)
		}
		if bits >= 32 {
			off := idx * 4
			if off+4 > len(frame) {
				return 0
			}
			v := int32(binary.LittleEndian.Uint32(frame[off : off+4]))
			return int16(v >> 16)
		}
		off := idx * 2
		if off+2 > len(frame) {
			return 0
		}
		return int16(binary.LittleEndian.Uint16(frame[off : off+2]))
	}
	l := read(0)
	r := l
	if channels > 1 {
		r = read(1)
	}
	return l, r
}

func resampleStereo(in []int16, srcRate, dstRate int) []int16 {
	inFrames := len(in) / 2
	if inFrames == 0 || srcRate < 1 {
		return nil
	}
	outFrames := inFrames * dstRate / srcRate
	out := make([]int16, outFrames*2)
	for i := 0; i < outFrames; i++ {
		src := float64(i) * float64(srcRate) / float64(dstRate)
		i0 := int(src)
		frac := src - float64(i0)
		i1 := i0 + 1
		if i0 >= inFrames {
			i0 = inFrames - 1
		}
		if i1 >= inFrames {
			i1 = inFrames - 1
		}
		for c := 0; c < 2; c++ {
			a := float64(in[i0*2+c])
			b := float64(in[i1*2+c])
			out[i*2+c] = int16(a + (b-a)*frac)
		}
	}
	return out
}
