//go:build !lite

package desktop

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/pion/webrtc/v4"
)

func testCandidate(n int) map[string]any {
	return map[string]any{
		"candidate":     fmt.Sprintf("candidate:%d 1 UDP 2130706431 127.0.0.1 %d typ host", n, 10000+n),
		"sdpMid":        "0",
		"sdpMLineIndex": n,
	}
}

func TestParseICECandidate(t *testing.T) {
	init, ok := parseICECandidate(testCandidate(0))
	if !ok || init.Candidate == "" || init.SDPMid == nil || *init.SDPMid != "0" {
		t.Fatalf("map init=%+v ok=%v", init, ok)
	}
	if init.SDPMLineIndex == nil || *init.SDPMLineIndex != 0 {
		t.Fatalf("mline=%v", init.SDPMLineIndex)
	}

	raw, err := json.Marshal(SignalPayload{Kind: "ice", Candidate: testCandidate(2)})
	if err != nil {
		t.Fatal(err)
	}
	var msg SignalPayload
	if err := json.Unmarshal(raw, &msg); err != nil {
		t.Fatal(err)
	}
	fromJSON, ok := parseICECandidate(msg.Candidate)
	if !ok || fromJSON.Candidate == "" {
		t.Fatalf("json any init=%+v ok=%v", fromJSON, ok)
	}
	if fromJSON.SDPMLineIndex == nil || *fromJSON.SDPMLineIndex != 2 {
		t.Fatalf("json mline=%v", fromJSON.SDPMLineIndex)
	}

	str, ok := parseICECandidate("candidate:1 1 UDP 1 127.0.0.1 9 typ host")
	if !ok || str.Candidate == "" {
		t.Fatalf("string init=%+v ok=%v", str, ok)
	}
	if _, ok := parseICECandidate(nil); ok {
		t.Fatal("nil should fail")
	}
	if _, ok := parseICECandidate(""); ok {
		t.Fatal("empty string should fail")
	}
	if _, ok := parseICECandidate(map[string]any{}); ok {
		t.Fatal("empty object should fail")
	}
}

func TestAddICEQueuesUntilRemoteReady(t *testing.T) {
	s := New(nil, func(SignalPayload) {}, "")
	s.addICE(testCandidate(1))
	s.addICE(nil)
	s.mu.Lock()
	n := len(s.pendingICE)
	ready := s.remoteReady
	s.mu.Unlock()
	if n != 1 || ready {
		t.Fatalf("pending=%d ready=%v", n, ready)
	}

	s.mu.Lock()
	s.flushICELocked()
	kept := len(s.pendingICE)
	s.mu.Unlock()
	if kept != 1 {
		t.Fatalf("flush without pc/remote dropped queue: %d", kept)
	}
}

func TestHandleICEQueuesBeforePC(t *testing.T) {
	s := New(nil, func(SignalPayload) {}, "")
	raw, err := json.Marshal(SignalPayload{Kind: "ice", Candidate: testCandidate(3)})
	if err != nil {
		t.Fatal(err)
	}
	s.Handle(raw)
	s.mu.Lock()
	n := len(s.pendingICE)
	s.mu.Unlock()
	if n != 1 {
		t.Fatalf("handle ice pending=%d", n)
	}
}

func TestCloseClearsPendingICE(t *testing.T) {
	s := New(nil, func(SignalPayload) {}, "")
	s.addICE(testCandidate(1))
	s.Close()
	s.mu.Lock()
	n := len(s.pendingICE)
	ready := s.remoteReady
	s.mu.Unlock()
	if n != 0 || ready {
		t.Fatalf("after close pending=%d ready=%v", n, ready)
	}
}

func TestAddICECapsQueue(t *testing.T) {
	s := New(nil, func(SignalPayload) {}, "")
	for i := 0; i < maxPendingICE+7; i++ {
		s.addICE(testCandidate(i))
	}
	s.mu.Lock()
	n := len(s.pendingICE)
	first := s.pendingICE[0].Candidate
	s.mu.Unlock()
	if n != maxPendingICE {
		t.Fatalf("capped=%d want=%d", n, maxPendingICE)
	}
	if first == testCandidate(0)["candidate"] {
		t.Fatal("oldest candidate was not dropped")
	}
}

func TestInstallPCPreservesQueuedICE(t *testing.T) {
	s := New(nil, func(SignalPayload) {}, "")
	s.addICE(testCandidate(1))
	s.addICE(testCandidate(2))

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = pc.Close() }()

	s.mu.Lock()
	pending := s.pendingICE
	s.closeLocked()
	s.pendingICE = pending
	s.pc = pc
	s.remoteReady = false
	n := len(s.pendingICE)
	s.mu.Unlock()
	if n != 2 {
		t.Fatalf("replace pc dropped queue: %d", n)
	}
}

func TestMarkRemoteReadyFlushesQueuedICE(t *testing.T) {
	s := New(nil, func(SignalPayload) {}, "")
	s.addICE(testCandidate(1))

	offerPC, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = offerPC.Close() }()
	if _, err := offerPC.CreateDataChannel("desktop", nil); err != nil {
		t.Fatal(err)
	}
	offer, err := offerPC.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := offerPC.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}

	answerPC, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = answerPC.Close() }()

	s.mu.Lock()
	pending := s.pendingICE
	s.closeLocked()
	s.pendingICE = pending
	s.pc = answerPC
	s.remoteReady = false
	s.mu.Unlock()

	if err := answerPC.SetRemoteDescription(offer); err != nil {
		t.Fatal(err)
	}
	s.markRemoteReady(answerPC)
	s.mu.Lock()
	n := len(s.pendingICE)
	ready := s.remoteReady
	s.mu.Unlock()
	if n != 0 || !ready {
		t.Fatalf("flush pending=%d ready=%v", n, ready)
	}
}

func TestMarkRemoteReadyIgnoresStalePC(t *testing.T) {
	s := New(nil, func(SignalPayload) {}, "")
	s.addICE(testCandidate(1))
	old, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = old.Close() }()
	cur, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cur.Close() }()

	s.mu.Lock()
	s.pc = cur
	s.mu.Unlock()
	s.markRemoteReady(old)
	s.mu.Lock()
	n := len(s.pendingICE)
	ready := s.remoteReady
	s.mu.Unlock()
	if n != 1 || ready {
		t.Fatalf("stale mark flushed pending=%d ready=%v", n, ready)
	}
}
