package notify

import (
	"bytes"
	"strings"
	"testing"
)

func TestKnownKinds(t *testing.T) {
	want := []string{
		KindEnrolled, KindWSDown, KindWSUp, KindUpdateApplied,
		KindDesktopIncoming, KindMeshPeer, KindAgentRecovering, KindQuickAssist,
	}
	for _, k := range want {
		if !KnownKind(k) {
			t.Fatalf("missing kind %q", k)
		}
		msg := Message{Kind: k}.Normalized()
		if msg.Title == "" || msg.Body == "" {
			t.Fatalf("%s defaults empty: %+v", k, msg)
		}
		if err := msg.Validate(); err != nil {
			t.Fatal(err)
		}
	}
	if KnownKind("chat") || KnownKind("") {
		t.Fatal("unknown kinds must be rejected")
	}
}

func TestDesktopIncomingCopy(t *testing.T) {
	msg := Message{Kind: KindDesktopIncoming}.Normalized()
	if msg.Title != "Remote desktop" {
		t.Fatalf("title %q", msg.Title)
	}
	if msg.Body != "Remote desktop session starting." {
		t.Fatalf("body %q", msg.Body)
	}
}

func TestWriteReadRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	in := Message{Kind: KindWSDown, Title: "Agent", Body: "WS lost"}
	if err := WriteMessage(&buf, in); err != nil {
		t.Fatal(err)
	}
	got, err := ReadMessage(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != KindWSDown || got.Title != "Agent" || got.Body != "WS lost" {
		t.Fatalf("got %+v", got)
	}
}

func TestWriteFillsDefaults(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteMessage(&buf, Message{Kind: KindEnrolled}); err != nil {
		t.Fatal(err)
	}
	got, err := ReadMessage(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != DefaultTitle(KindEnrolled) || got.Body != DefaultBody(KindEnrolled) {
		t.Fatalf("got %+v", got)
	}
}

func TestWriteRejectsUnknownKind(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteMessage(&buf, Message{Kind: "operator_chat"}); err == nil {
		t.Fatal("expected error")
	}
}

func TestReadRejectsUnknownKind(t *testing.T) {
	_, err := ReadMessage(strings.NewReader(`{"kind":"operator_chat","title":"x","body":"y"}` + "\n"))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestPipeName(t *testing.T) {
	if PipeName != `\\.\pipe\pc-manager-notify` {
		t.Fatal(PipeName)
	}
}

func TestShowKindRejectsUnknown(t *testing.T) {
	if err := ShowKind("operator_chat"); err == nil {
		t.Fatal("expected error")
	}
}
