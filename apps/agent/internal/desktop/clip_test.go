//go:build !lite

package desktop

import (
	"encoding/json"
	"testing"
)

func TestClipRingList(t *testing.T) {
	r := newClipRing(4)
	r.Push("a")
	r.PushClip(clipItem{Kind: "html", HTML: "<b>b</b>", Text: "b"})
	list := r.List()
	if len(list) != 2 || list[0].Text != "a" || list[1].Kind != "html" {
		t.Fatalf("list=%+v", list)
	}
}

func TestClipRingDedupesAndCaps(t *testing.T) {
	r := newClipRing(3)
	r.Push("a")
	r.Push("a")
	if got := r.LastText(); got != "a" {
		t.Fatalf("last=%q", got)
	}
	r.mu.Lock()
	n := len(r.items)
	r.mu.Unlock()
	if n != 1 {
		t.Fatalf("dedupe size=%d", n)
	}
	r.Push("b")
	r.Push("c")
	r.Push("d")
	r.mu.Lock()
	texts := make([]string, len(r.items))
	for i, it := range r.items {
		texts[i] = it.Text
	}
	r.mu.Unlock()
	if len(texts) != 3 || texts[0] != "b" || texts[2] != "d" {
		t.Fatalf("ring=%v", texts)
	}
}

func TestClipRingStoresKind(t *testing.T) {
	r := newClipRing(4)
	r.PushClip(clipItem{Kind: "html", Text: "x", HTML: "<b>x</b>"})
	r.PushClip(clipItem{Kind: "files", Files: []string{`C:\a.txt`}})
	r.mu.Lock()
	n := len(r.items)
	last := r.items[n-1]
	r.mu.Unlock()
	if n != 2 || last.Kind != "files" || len(last.Files) != 1 {
		t.Fatalf("n=%d last=%+v", n, last)
	}
	raw := mustClipJSON(last)
	if len(raw) == 0 {
		t.Fatal("json")
	}
}

func TestClipItemFromWireKinds(t *testing.T) {
	html, ok := clipItemFromWire([]byte(`{"t":"clip","type":"clip","kind":"html","html":"<b>x</b>","text":"x","at":2}`))
	if !ok || html.Kind != "html" || html.HTML != "<b>x</b>" {
		t.Fatalf("html=%+v ok=%v", html, ok)
	}
	img, ok := clipItemFromWire([]byte(`{"t":"clip","kind":"image","image":{"mime":"image/png","data":"aaaa"},"at":4}`))
	if !ok || img.Kind != "image" || img.Mime != "image/png" || len(img.Image) == 0 {
		t.Fatalf("image=%+v ok=%v", img, ok)
	}
	files, ok := clipItemFromWire([]byte(`{"type":"clip","kind":"files","files":["C:\\\\a.txt"],"at":3}`))
	if !ok || files.Kind != "files" || len(files.Files) != 1 {
		t.Fatalf("files=%+v ok=%v", files, ok)
	}
}

func TestHangupPayloadJSON(t *testing.T) {
	raw, err := json.Marshal(SignalPayload{Kind: "hangup", Error: "webrtc_disabled", Reason: "webrtc_disabled"})
	if err != nil {
		t.Fatal(err)
	}
	var back SignalPayload
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if back.Kind != "hangup" || back.Error != "webrtc_disabled" || back.Reason != "webrtc_disabled" {
		t.Fatalf("back=%+v", back)
	}
}
