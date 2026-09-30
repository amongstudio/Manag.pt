// Package cliphist keeps a small in-memory clipboard history shared by the
// remote desktop session and the on-demand get_clipboard command. Nothing is
// persisted or logged, and entries are only recorded while an operator is
// connected or explicitly fetches the clipboard.
package cliphist

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"sync"
	"time"
)

// Max matches CLIPBOARD_HISTORY_MAX in packages/shared.
const Max = 50

type Item struct {
	Kind  string
	Text  string
	HTML  string
	Files []string
	Mime  string
	Image []byte
	At    int64
}

type Ring struct {
	mu    sync.Mutex
	items []Item
	capN  int
}

func New(n int) *Ring {
	if n < 1 {
		n = Max
	}
	return &Ring{capN: n}
}

// Default is the process-wide history.
var Default = New(Max)

// Key identifies clip content, ignoring timestamps, so repeated snapshots of
// an unchanged clipboard collapse to one entry.
func Key(it Item) string {
	var img string
	if len(it.Image) > 0 {
		sum := sha256.Sum256(it.Image)
		img = hex.EncodeToString(sum[:8])
	}
	return strings.Join([]string{it.Kind, it.Text, it.HTML, strings.Join(it.Files, "\x00"), it.Mime, img}, "\x01")
}

func (r *Ring) Push(text string) Item {
	return r.PushClip(Item{Kind: "text", Text: text})
}

// PushClip records item as newest. Unchanged newest content is a no-op that
// keeps the original timestamp; older duplicates move to the newest slot.
func (r *Ring) PushClip(item Item) Item {
	out, _ := r.PushChanged(item)
	return out
}

// PushChanged is PushClip that also reports whether the newest entry changed.
func (r *Ring) PushChanged(item Item) (Item, bool) {
	if item.At == 0 {
		item.At = time.Now().UnixMilli()
	}
	if r == nil {
		return item, true
	}
	key := Key(item)
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.items) - 1; i >= 0; i-- {
		if Key(r.items[i]) != key {
			continue
		}
		if i == len(r.items)-1 {
			return r.items[i], false
		}
		r.items = append(r.items[:i], r.items[i+1:]...)
		break
	}
	r.items = append(r.items, item)
	if len(r.items) > r.capN {
		r.items = r.items[len(r.items)-r.capN:]
	}
	return item, true
}

func (r *Ring) LastText() string {
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

// List returns oldest-first copies.
func (r *Ring) List() []Item {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Item, len(r.items))
	copy(out, r.items)
	return out
}

func (r *Ring) Len() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.items)
}

// Wire limits for the get_clipboard command result.
const (
	WireTextMax  = 16 * 1024
	WireImageMax = 256 * 1024
)

// Wire converts an item to the dashboard shape, truncating text and omitting
// large images.
func Wire(it Item) map[string]any {
	m := map[string]any{"kind": it.Kind, "at": it.At}
	if it.Text != "" {
		text, cut := truncate(it.Text, WireTextMax)
		m["text"] = text
		if cut {
			m["truncated"] = true
		}
	}
	if it.HTML != "" && it.Text == "" {
		html, cut := truncate(it.HTML, WireTextMax)
		m["html"] = html
		if cut {
			m["truncated"] = true
		}
	}
	if len(it.Files) > 0 {
		files := it.Files
		if len(files) > 64 {
			files = files[:64]
			m["truncated"] = true
		}
		m["files"] = files
	}
	if len(it.Image) > 0 {
		mime := it.Mime
		if mime == "" {
			mime = "image/png"
		}
		if len(it.Image) <= WireImageMax {
			m["image"] = map[string]any{"mime": mime, "data": base64.StdEncoding.EncodeToString(it.Image)}
		} else {
			m["imageOmitted"] = true
			m["imageBytes"] = len(it.Image)
		}
	}
	return m
}

func truncate(s string, n int) (string, bool) {
	if len(s) <= n {
		return s, false
	}
	cut := n
	for cut > 0 && cut < len(s) && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut], true
}
