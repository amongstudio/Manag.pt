package transfer

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pc-manager/agent/internal/client"
	"github.com/pc-manager/agent/internal/wsprotocol"
)

func TestHandleDoesNotDropWhenBufferFull(t *testing.T) {
	e := New(nil, nil, nil)
	ch := e.arm("t1")
	const n = 40
	for i := 0; i < n; i++ {
		e.Handle(wsprotocol.FileChunk{TransferID: "t1", Action: "ack", Offset: int64(i)}, []byte("x"))
	}
	got := 0
	deadline := time.After(2 * time.Second)
	for got < n {
		select {
		case <-ch:
			got++
		case <-deadline:
			t.Fatalf("got %d want %d (chunks were dropped)", got, n)
		}
	}
	e.disarm("t1")
}

func TestUploadRejectsOverCap(t *testing.T) {
	prev := client.MaxUploadBytes()
	client.ApplyMaxUploadBytes(8)
	t.Cleanup(func() { client.ApplyMaxUploadBytes(prev) })

	dir := t.TempDir()
	path := filepath.Join(dir, "big.bin")
	if err := os.WriteFile(path, []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	e := New(nil, nil, nil)
	err := e.Upload(path, "remote.bin", nil)
	if err == nil || err.Error() != "too_large" {
		t.Fatalf("got %v, want too_large", err)
	}
}
