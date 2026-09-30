package cliphist

import (
	"strings"
	"testing"
)

func TestPushUnchangedIsNoop(t *testing.T) {
	r := New(4)
	first := r.PushClip(Item{Kind: "text", Text: "a", At: 1})
	again := r.PushClip(Item{Kind: "text", Text: "a", At: 99})
	if r.Len() != 1 || again.At != first.At {
		t.Fatalf("len=%d at=%d", r.Len(), again.At)
	}
}

func TestPushMovesOlderDuplicateToNewest(t *testing.T) {
	r := New(4)
	r.Push("a")
	r.Push("b")
	r.Push("a")
	list := r.List()
	if len(list) != 2 || list[0].Text != "b" || list[1].Text != "a" {
		t.Fatalf("list=%+v", list)
	}
}

func TestKeyIncludesFilesAndImage(t *testing.T) {
	a := Item{Kind: "files", Files: []string{`C:\a`}}
	b := Item{Kind: "files", Files: []string{`C:\b`}}
	if Key(a) == Key(b) {
		t.Fatal("files must differ")
	}
	i1 := Item{Kind: "image", Mime: "image/png", Image: []byte{1, 2, 3}}
	i2 := Item{Kind: "image", Mime: "image/png", Image: []byte{1, 2, 4}}
	if Key(i1) == Key(i2) {
		t.Fatal("images must differ")
	}
}

func TestCap(t *testing.T) {
	r := New(3)
	for _, s := range []string{"a", "b", "c", "d"} {
		r.Push(s)
	}
	list := r.List()
	if len(list) != 3 || list[0].Text != "b" || list[2].Text != "d" {
		t.Fatalf("list=%+v", list)
	}
}

func TestWireTruncatesAndOmitsLargeImages(t *testing.T) {
	w := Wire(Item{Kind: "text", Text: strings.Repeat("é", WireTextMax), At: 1})
	text := w["text"].(string)
	if len(text) > WireTextMax || w["truncated"] != true || !strings.HasSuffix(text, "é") {
		t.Fatalf("len=%d truncated=%v", len(text), w["truncated"])
	}
	big := Wire(Item{Kind: "image", Image: make([]byte, WireImageMax+1)})
	if big["image"] != nil || big["imageOmitted"] != true {
		t.Fatalf("big=%v", big)
	}
}
