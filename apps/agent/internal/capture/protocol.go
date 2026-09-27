package capture

const (
	opCapture   = "capture"
	opH264      = "h264"
	opDisplays  = "displays"
	opClipGet   = "clip_get"
	opClipSet   = "clip_set"
	opClipWatch = "clip_watch"
	opClip      = "clip"
	opPing      = "ping"
	opQuit      = "quit"

	formatJPEG = "jpeg"
	formatBGRA = "bgra"
	formatNV12 = "nv12"
)

// pipeCaptureFormat keeps JPEG, BGRA, and NV12 on the capture-helper pipe.
// Raw frames are scaled in the helper so the body stays under maxBodyBytes.
func pipeCaptureFormat(format string) string {
	switch format {
	case formatJPEG:
		return formatJPEG
	case formatNV12:
		return formatNV12
	case formatBGRA:
		return formatBGRA
	default:
		if format == "" {
			return formatJPEG
		}
		return formatBGRA
	}
}

type Header struct {
	ID       uint32        `json:"id"`
	Op       string        `json:"op"`
	OK       bool          `json:"ok,omitempty"`
	Error    string        `json:"error,omitempty"`
	Display  int           `json:"display,omitempty"`
	MaxWidth int           `json:"maxWidth,omitempty"`
	Quality  int           `json:"quality,omitempty"`
	FPS      int           `json:"fps,omitempty"`
	Bitrate  int           `json:"bitrate,omitempty"`
	Format   string        `json:"format,omitempty"`
	Width    int           `json:"width,omitempty"`
	Height   int           `json:"height,omitempty"`
	Kind     string        `json:"kind,omitempty"`
	Text     string        `json:"text,omitempty"`
	HTML     string        `json:"html,omitempty"`
	Mime     string        `json:"mime,omitempty"`
	Files    []string      `json:"files,omitempty"`
	Displays []DisplayInfo `json:"displays,omitempty"`
	Watch    bool          `json:"watch,omitempty"`
}

func clipToHeader(c Clip) Header {
	return Header{
		Op:    opClip,
		OK:    true,
		Kind:  c.Kind,
		Text:  c.Text,
		HTML:  c.HTML,
		Mime:  c.Mime,
		Files: c.Files,
	}
}

func headerToClip(h Header, body []byte) Clip {
	return Clip{
		Kind:  h.Kind,
		Text:  h.Text,
		HTML:  h.HTML,
		Mime:  h.Mime,
		Files: h.Files,
		Image: body,
	}
}
