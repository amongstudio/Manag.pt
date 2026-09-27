package e2e

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func TestSealOpenRoundtrip(t *testing.T) {
	dir := t.TempDir()
	box, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	operator := mustBox(t, t.TempDir())
	if err := box.AcceptOffer("sess1", operator.PubHex()); err != nil {
		t.Fatal(err)
	}
	if err := operator.AcceptOffer("sess1", box.PubHex()); err != nil {
		t.Fatal(err)
	}
	env, err := box.Seal("screenshot", []byte("jpeg-bytes"), "")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := operator.Open(env.Nonce, env.Ciphertext, env.AAD)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(plain, []byte("jpeg-bytes")) {
		t.Fatalf("got %q", plain)
	}
}

func TestLoadOrCreateRejectsCorruptKey(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, keyFileName), []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreate(dir); err == nil {
		t.Fatal("expected corrupt key to fail instead of regenerating")
	}
}

func TestDecodeChunkPlainRejectsHugeHeader(t *testing.T) {
	plain := make([]byte, 8)
	binary.BigEndian.PutUint32(plain[:4], 0xffffffff)
	if _, _, err := DecodeChunkPlain(plain); err == nil {
		t.Fatal("expected truncated header")
	}
}

func mustBox(t *testing.T, dir string) *Box {
	t.Helper()
	b, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
