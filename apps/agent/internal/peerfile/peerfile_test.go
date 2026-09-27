package peerfile

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTicketsEqualAndRefuseUnknownOp(t *testing.T) {
	a := Ticket{
		CopyID: "c1", SrcDeviceID: "s", DstDeviceID: "d",
		SrcPath: "/a", DestPath: "/b", Exp: 9, MaxBytes: 10, Port: 17891,
		Addrs: []string{"10.0.0.2", "10.0.0.1"}, Sig: "abcd",
	}
	b := a
	b.Addrs = []string{"10.0.0.1", "10.0.0.2"}
	if !ticketsEqual(a, b) {
		t.Fatal("addrs should match unordered")
	}
	b.Sig = "abce"
	if ticketsEqual(a, b) {
		t.Fatal("sig mismatch")
	}

	var buf bytes.Buffer
	if err := writeFrame(&buf, header{Op: "command", Message: "get_processes"}); err != nil {
		t.Fatal(err)
	}
	h, err := readFrame(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if h.Op == "offer" {
		t.Fatal("must not treat command as offer")
	}
	if h.Op != "command" {
		t.Fatalf("op=%s", h.Op)
	}
}

func TestListenOfferRoundTrip(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.txt")
	dstDir := filepath.Join(dir, "dst")
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	payload := []byte("hello-peer-file")
	if err := os.WriteFile(src, payload, 0o644); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	ticket := Ticket{
		CopyID: "c1", SrcDeviceID: "src", DstDeviceID: "dst",
		SrcPath: src, DestPath: dstDir, Exp: time.Now().Add(time.Minute).Unix(),
		MaxBytes: 1 << 20, Port: port, Addrs: []string{"127.0.0.1"}, Sig: "aa",
	}
	// 127.0.0.1 is not RFC1918; the protocol still dials ticketed addrs.
	errCh := make(chan error, 1)
	go func() {
		_, err := Listen("dst", dstDir, ticket, nil)
		errCh <- err
	}()
	time.Sleep(200 * time.Millisecond)
	var res Result
	var offerErr error
	for i := 0; i < 10; i++ {
		res, offerErr = Offer("src", src, ticket, nil)
		if offerErr == nil || !errors.Is(offerErr, ErrDial) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if offerErr != nil {
		t.Fatalf("offer: %v", offerErr)
	}
	if res.Via != "lan" || res.Size != int64(len(payload)) {
		t.Fatalf("result=%+v", res)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("listen: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dstDir, "src.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("copied %q", got)
	}
	sum := sha256.Sum256(payload)
	if res.SHA256 != hashHex(sum) {
		t.Fatalf("hash %s", res.SHA256)
	}
}

func TestParseTicket(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{
		"ticket": Ticket{CopyID: "x", Sig: "s", Port: 17891, SrcDeviceID: "a", DstDeviceID: "b", SrcPath: "/a", DestPath: "/b", Exp: 1, MaxBytes: 2},
		"fileId": "f1",
	})
	p, err := ParsePayload(raw)
	if err != nil {
		t.Fatal(err)
	}
	if p.FileID != "f1" || p.Ticket.CopyID != "x" {
		t.Fatalf("%+v", p)
	}
}

func TestCopyProgressEOF(t *testing.T) {
	n, err := copyProgress(io.Discard, bytes.NewReader([]byte("abc")), 3, nil)
	if err != nil || n != 3 {
		t.Fatalf("n=%d err=%v", n, err)
	}
}

func TestParseMeshPayload(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{
		"mesh": true, "copyId": "c1", "destDeviceId": "dst", "srcPath": "/a", "destPath": "/b",
		"addrs": []string{"10.0.0.2"}, "port": 17891,
	})
	p, err := ParsePayload(raw)
	if err != nil || !p.Mesh || p.DestDeviceID != "dst" {
		t.Fatalf("%+v err=%v", p, err)
	}
	if _, err := ParsePayload([]byte(`{"mesh":true}`)); err == nil {
		t.Fatal("mesh payload requires destPath")
	}
}
