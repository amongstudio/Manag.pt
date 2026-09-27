//go:build windows

package winops

import (
	"errors"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	evtQueryChannelPath      = 0x1
	evtQueryReverseDirection = 0x200
	evtRenderEventValues     = 0
	evtRenderContextSystem   = 1
	evtFormatMessageEvent    = 1
	evtSystemProviderName    = 0
	evtSystemEventID         = 2
	evtSystemLevel           = 4
	evtSystemTimeCreated     = 8
	evtSystemChannel         = 14
	evtSystemPropertyIdEND   = 18
	evtVarTypeNull           = 0
	evtVarTypeString         = 1
	evtVarTypeAnsiString     = 2
	evtVarTypeSByte          = 3
	evtVarTypeByte           = 4
	evtVarTypeInt16          = 5
	evtVarTypeUInt16         = 6
	evtVarTypeInt32          = 7
	evtVarTypeUInt32         = 8
	evtVarTypeInt64          = 9
	evtVarTypeUInt64         = 10
	evtVarTypeBoolean        = 13
	evtVarTypeFileTime       = 17
	evtVarTypeHexInt32       = 20
	evtVarTypeHexInt64       = 21
)

var (
	wevtapi                      = windows.NewLazySystemDLL("wevtapi.dll")
	procEvtQuery                 = wevtapi.NewProc("EvtQuery")
	procEvtNext                  = wevtapi.NewProc("EvtNext")
	procEvtClose                 = wevtapi.NewProc("EvtClose")
	procEvtRender                = wevtapi.NewProc("EvtRender")
	procEvtCreateRenderContext   = wevtapi.NewProc("EvtCreateRenderContext")
	procEvtFormatMessage         = wevtapi.NewProc("EvtFormatMessage")
	procEvtOpenPublisherMetadata = wevtapi.NewProc("EvtOpenPublisherMetadata")
)

type evtVariant struct {
	data  uint64
	count uint32
	typ   uint32
}

func (v evtVariant) kind() uint32 { return v.typ & 0xff }

func EventLog(req EventLogRequest) (*EventLogResult, error) {
	if req.Log == "" {
		req.Log = "System"
	}
	if req.Newest <= 0 {
		req.Newest = defaultNewest
	}
	if req.Newest > maxNewest {
		req.Newest = maxNewest
	}
	path, err := windows.UTF16PtrFromString(req.Log)
	if err != nil {
		return nil, ErrInvalidPayload
	}
	query, err := windows.UTF16PtrFromString(xpathForLevel(req.Level))
	if err != nil {
		return nil, ErrInvalidPayload
	}
	h, _, e := procEvtQuery.Call(0, uintptr(unsafe.Pointer(path)), uintptr(unsafe.Pointer(query)), evtQueryChannelPath|evtQueryReverseDirection)
	if h == 0 {
		return nil, mapEvtErr(e)
	}
	defer evtClose(h)

	ctx, _, e := procEvtCreateRenderContext.Call(0, 0, evtRenderContextSystem)
	if ctx == 0 {
		return nil, mapEvtErr(e)
	}
	defer evtClose(ctx)

	out := &EventLogResult{Log: req.Log, Entries: []EventEntry{}}
	meta := map[string]uintptr{}
	defer func() {
		for _, m := range meta {
			evtClose(m)
		}
	}()

	handles := make([]uintptr, 16)
	for len(out.Entries) < req.Newest {
		var returned uint32
		r, _, nextErr := procEvtNext.Call(h, uintptr(len(handles)), uintptr(unsafe.Pointer(&handles[0])), 2000, 0, uintptr(unsafe.Pointer(&returned)))
		if r == 0 {
			if isEvtDone(nextErr) {
				break
			}
			return nil, mapEvtErr(nextErr)
		}
		for i := uint32(0); i < returned; i++ {
			if len(out.Entries) < req.Newest {
				if entry, err := renderEvent(ctx, handles[i], meta); err == nil {
					out.Entries = append(out.Entries, entry)
				}
			}
			evtClose(handles[i])
			handles[i] = 0
		}
	}
	if len(out.Entries) >= req.Newest {
		out.Truncated = true
	}
	return out, nil
}

func renderEvent(ctx, event uintptr, meta map[string]uintptr) (EventEntry, error) {
	vars, err := renderValues(ctx, event)
	if err != nil {
		return EventEntry{}, err
	}
	if len(vars) < evtSystemPropertyIdEND {
		return EventEntry{}, ErrQueryFailed
	}
	entry := EventEntry{
		Time:    fileTimeRFC3339(vars[evtSystemTimeCreated]),
		Type:    levelName(uint8(vars[evtSystemLevel].uintVal())),
		Source:  vars[evtSystemProviderName].stringVal(),
		ID:      uint32(vars[evtSystemEventID].uintVal()),
		Channel: vars[evtSystemChannel].stringVal(),
	}
	entry.Message = clipMessage(formatEvent(event, entry.Source, meta))
	return entry, nil
}

func renderValues(ctx, event uintptr) ([]evtVariant, error) {
	var used, count uint32
	buf := make([]byte, 4096)
	for {
		r, _, e := procEvtRender.Call(ctx, event, evtRenderEventValues, uintptr(len(buf)), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&used)), uintptr(unsafe.Pointer(&count)))
		if r != 0 {
			if count == 0 || int(count)*int(unsafe.Sizeof(evtVariant{})) > len(buf) {
				return nil, ErrQueryFailed
			}
			return unsafe.Slice((*evtVariant)(unsafe.Pointer(&buf[0])), int(count)), nil
		}
		if !isEvtTooSmall(e) || used <= uint32(len(buf)) {
			return nil, mapEvtErr(e)
		}
		buf = make([]byte, used)
	}
}

func formatEvent(event uintptr, provider string, meta map[string]uintptr) string {
	h := meta[provider]
	if h == 0 && provider != "" {
		name, err := windows.UTF16PtrFromString(provider)
		if err == nil {
			mh, _, _ := procEvtOpenPublisherMetadata.Call(0, uintptr(unsafe.Pointer(name)), 0, 0, 0)
			if mh != 0 {
				meta[provider] = mh
				h = mh
			}
		}
	}
	var used uint32
	buf := make([]uint16, 512)
	for {
		r, _, e := procEvtFormatMessage.Call(h, event, 0, 0, 0, evtFormatMessageEvent, uintptr(len(buf)), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&used)))
		if r != 0 {
			return windows.UTF16ToString(buf)
		}
		if !isEvtTooSmall(e) || used <= uint32(len(buf)) {
			return ""
		}
		buf = make([]uint16, used)
	}
}

func (v evtVariant) uintVal() uint64 {
	switch v.kind() {
	case evtVarTypeByte, evtVarTypeUInt16, evtVarTypeUInt32, evtVarTypeUInt64, evtVarTypeHexInt32, evtVarTypeHexInt64, evtVarTypeSByte, evtVarTypeInt16, evtVarTypeInt32, evtVarTypeInt64, evtVarTypeBoolean:
		return v.data
	default:
		return 0
	}
}

func (v evtVariant) stringVal() string {
	if v.kind() != evtVarTypeString || v.data == 0 {
		return ""
	}
	return windows.UTF16PtrToString((*uint16)(unsafe.Pointer(uintptr(v.data))))
}

func fileTimeRFC3339(v evtVariant) string {
	if v.kind() != evtVarTypeFileTime || v.data == 0 {
		return ""
	}
	const epochDiff uint64 = 116444736000000000
	if v.data < epochDiff {
		return ""
	}
	return time.Unix(0, int64((v.data-epochDiff)*100)).UTC().Format(time.RFC3339)
}

func levelName(v uint8) string {
	switch v {
	case 1:
		return "Critical"
	case 2:
		return "Error"
	case 3:
		return "Warning"
	case 4:
		return "Information"
	case 5:
		return "Verbose"
	default:
		return "LogAlways"
	}
}

func evtClose(h uintptr) {
	if h != 0 {
		_, _, _ = procEvtClose.Call(h)
	}
}

func isEvtDone(err error) bool {
	if err == nil {
		return true
	}
	return errors.Is(err, windows.ERROR_NO_MORE_ITEMS) ||
		errors.Is(err, syscall.Errno(259)) ||
		errors.Is(err, windows.ERROR_SUCCESS) ||
		errors.Is(err, syscall.Errno(1460))
}

func isEvtTooSmall(err error) bool {
	return errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) || errors.Is(err, syscall.Errno(122))
}

func mapEvtErr(err error) error {
	if err == nil {
		return ErrQueryFailed
	}
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, syscall.Errno(5)) {
		return ErrAccessDenied
	}
	if strings.Contains(strings.ToLower(err.Error()), "access") {
		return ErrAccessDenied
	}
	return ErrQueryFailed
}
