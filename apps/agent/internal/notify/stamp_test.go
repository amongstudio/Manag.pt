package notify

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUncleanStartStamp(t *testing.T) {
	dir := t.TempDir()
	if TakeUncleanStart(dir) {
		t.Fatal("fresh dir")
	}
	if TakeUncleanStart("") {
		t.Fatal("empty")
	}
	MarkAlive(dir)
	if !TakeUncleanStart(dir) {
		t.Fatal("expected leftover alive file")
	}
	MarkCleanStop(dir)
	if TakeUncleanStart(dir) {
		t.Fatal("clean stop should clear")
	}
}

func TestNoteVersionChange(t *testing.T) {
	dir := t.TempDir()
	prev, changed := NoteVersion(dir, "3.2.2")
	if prev != "" || changed {
		t.Fatalf("first write prev=%q changed=%v", prev, changed)
	}
	prev, changed = NoteVersion(dir, "3.2.2")
	if prev != "3.2.2" || changed {
		t.Fatalf("same version prev=%q changed=%v", prev, changed)
	}
	prev, changed = NoteVersion(dir, "3.3.0")
	if prev != "3.2.2" || !changed {
		t.Fatalf("upgrade prev=%q changed=%v", prev, changed)
	}
	raw, err := os.ReadFile(filepath.Join(dir, versionFile))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "3.3.0\n" {
		t.Fatalf("stored %q", raw)
	}
}

func TestNoteVersionEmpty(t *testing.T) {
	if _, changed := NoteVersion("", "1"); changed {
		t.Fatal("empty dir")
	}
	if _, changed := NoteVersion(t.TempDir(), ""); changed {
		t.Fatal("empty version")
	}
}
