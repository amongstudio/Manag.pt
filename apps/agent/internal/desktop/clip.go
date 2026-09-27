//go:build !lite

package desktop

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/pc-manager/agent/internal/capture"
)

const clipRingMax = 32

type clipItem struct {
	Kind  string
	Text  string
	HTML  string
	Files []string
	Mime  string
	Image []byte
	At    int64
}

type clipRing struct {
	mu    sync.Mutex
	items []clipItem
	capN  int
}

func newClipRing(n int) *clipRing {
	if n < 1 {
		n = clipRingMax
	}
	return &clipRing{capN: n}
}

func clipKey(it clipItem) string {
	return it.Kind + "\n" + it.Text + "\n" + it.HTML + "\n" + it.Mime
}

func (r *clipRing) Push(text string) clipItem {
	return r.PushClip(clipItem{Kind: "text", Text: text})
}

func (r *clipRing) PushClip(item clipItem) clipItem {
	if item.At == 0 {
		item.At = time.Now().UnixMilli()
	}
	if r == nil {
		return item
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if n := len(r.items); n > 0 && clipKey(r.items[n-1]) == clipKey(item) {
		r.items[n-1] = item
		return item
	}
	r.items = append(r.items, item)
	if len(r.items) > r.capN {
		r.items = r.items[len(r.items)-r.capN:]
	}
	return item
}

func (r *clipRing) LastText() string {
	if r == nil {
		return ""
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.items) == 0 {
		return ""
	}
	return r.items[len(r.items)-1].Text
}

func (r *clipRing) List() []clipItem {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]clipItem, len(r.items))
	copy(out, r.items)
	return out
}

func clipFromCapture(c capture.Clip) clipItem {
	kind := c.Kind
	if kind == "" {
		kind = "text"
	}
	if len(c.Text) > clipCap {
		c.Text = c.Text[:clipCap]
	}
	if len(c.HTML) > clipCap {
		c.HTML = c.HTML[:clipCap]
	}
	return clipItem{
		Kind:  kind,
		Text:  c.Text,
		HTML:  c.HTML,
		Files: c.Files,
		Mime:  c.Mime,
		Image: c.Image,
	}
}

type clipWire struct {
	T     string   `json:"t"`
	Type  string   `json:"type"`
	Kind  string   `json:"kind"`
	Text  string   `json:"text"`
	HTML  string   `json:"html"`
	Files []string `json:"files"`
	Mime  string   `json:"mime"`
	Data  string   `json:"data"`
	Image *struct {
		Mime   string `json:"mime"`
		Data   string `json:"data"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	} `json:"image"`
	At int64 `json:"at"`
}

func clipItemFromWire(raw []byte) (clipItem, bool) {
	var w clipWire
	if json.Unmarshal(raw, &w) != nil {
		return clipItem{}, false
	}
	if w.T != "clip" && w.Type != "clip" {
		return clipItem{}, false
	}
	mime := w.Mime
	var img []byte
	if w.Image != nil && w.Image.Data != "" {
		if w.Image.Mime != "" {
			mime = w.Image.Mime
		}
		if b, err := base64.StdEncoding.DecodeString(w.Image.Data); err == nil {
			img = b
		}
	} else if w.Data != "" && (w.Kind == "image" || strings.HasPrefix(mime, "image/")) {
		if b, err := base64.StdEncoding.DecodeString(w.Data); err == nil {
			img = b
		}
	}
	kind := w.Kind
	if kind == "" {
		switch {
		case len(img) > 0:
			kind = "image"
		case len(w.Files) > 0:
			kind = "files"
		case w.HTML != "" && w.Text == "":
			kind = "html"
		default:
			kind = "text"
		}
	}
	if w.Text == "" && w.HTML == "" && len(img) == 0 && len(w.Files) == 0 {
		return clipItem{}, false
	}
	return clipItem{Kind: kind, Text: w.Text, HTML: w.HTML, Files: w.Files, Mime: mime, Image: img, At: w.At}, true
}

func (item clipItem) toCapture() capture.Clip {
	return capture.Clip{
		Kind:  item.Kind,
		Text:  item.Text,
		HTML:  item.HTML,
		Files: item.Files,
		Mime:  item.Mime,
		Image: item.Image,
	}
}

func mustClipJSON(item clipItem) []byte {
	m := map[string]any{
		"type": "clip",
		"kind": item.Kind,
		"at":   item.At,
	}
	if item.Text != "" {
		m["text"] = item.Text
	}
	if item.HTML != "" {
		m["html"] = item.HTML
	}
	if len(item.Files) > 0 {
		m["files"] = item.Files
	}
	if len(item.Image) > 0 {
		mime := item.Mime
		if mime == "" {
			mime = "image/png"
		}
		m["image"] = map[string]any{
			"mime": mime,
			"data": base64.StdEncoding.EncodeToString(item.Image),
		}
	}
	raw, _ := json.Marshal(m)
	return raw
}
