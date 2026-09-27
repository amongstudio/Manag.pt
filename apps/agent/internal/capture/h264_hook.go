package capture

// H264EncodeFunc captures and encodes one frame in the capture-helper process.
type H264EncodeFunc func(display, maxWidth, fps, bitrate int) ([]byte, int, int, error)

var h264EncodeFn H264EncodeFunc

func SetH264Encode(fn H264EncodeFunc) { h264EncodeFn = fn }
