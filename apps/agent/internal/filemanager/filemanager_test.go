package filemanager

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func testSandbox(t *testing.T) (*Sandbox, string) {
	t.Helper()
	root := t.TempDir()
	sb := New([]string{root})
	return sb, root
}

func TestListTruncated(t *testing.T) {
	sb, root := testSandbox(t)
	for i := 0; i < maxList+3; i++ {
		name := filepath.Join(root, fmt.Sprintf("f-%04d.txt", i))
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	list, err := sb.List(root)
	if err != nil {
		t.Fatal(err)
	}
	if !list.Truncated {
		t.Fatalf("expected truncated listing, got %d entries", len(list.Entries))
	}
	if len(list.Entries) != maxList {
		t.Fatalf("entries=%d want %d", len(list.Entries), maxList)
	}
	if list.Path == "" || len(list.Roots) == 0 {
		t.Fatalf("missing path/roots: %+v", list)
	}
	if list.Entries[0].Mtime.IsZero() {
		t.Fatal("expected mtime")
	}
}

func TestCopyFile(t *testing.T) {
	sb, root := testSandbox(t)
	src := filepath.Join(root, "src.txt")
	dst := filepath.Join(root, "dst.txt")
	if err := os.WriteFile(src, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := sb.Copy(src, dst); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello" {
		t.Fatalf("copied %q", got)
	}
}

func TestDeleteDirectory(t *testing.T) {
	sb, root := testSandbox(t)
	dir := filepath.Join(root, "nested")
	if err := os.MkdirAll(filepath.Join(dir, "inner"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "inner", "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := sb.Delete(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("dir still present: %v", err)
	}
}

func TestResolveAllowsPathsOutsideConfiguredRoots(t *testing.T) {
	configured := t.TempDir()
	outside := t.TempDir()
	sb := New([]string{configured})
	got, err := sb.Resolve(outside)
	if err != nil {
		t.Fatalf("Resolve(%q): %v", outside, err)
	}
	if got != canonicalize(outside) {
		t.Fatalf("resolved %q want %q", got, canonicalize(outside))
	}
}

func TestResolveRejectsMalformedPaths(t *testing.T) {
	sb, _ := testSandbox(t)
	traversal := "safe" + string(filepath.Separator) + ".." + string(filepath.Separator) + "other"
	for _, path := range []string{"bad\x00path", "bad\npath", traversal} {
		if _, err := sb.Resolve(path); err == nil {
			t.Fatalf("Resolve(%q) unexpectedly succeeded", path)
		}
	}
	if runtime.GOOS == "windows" {
		for _, path := range []string{`C:relative`, `\\.\PhysicalDrive0`, `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`} {
			if _, err := sb.Resolve(path); err == nil {
				t.Fatalf("Resolve(%q) unexpectedly succeeded", path)
			}
		}
	}
}

func TestFilesystemRootsAreProtected(t *testing.T) {
	for _, root := range platformRoots() {
		if !isFilesystemRoot(root) {
			t.Fatalf("%q should be recognized as a filesystem root", root)
		}
	}
}

func TestPreviewTextTruncated(t *testing.T) {
	sb, root := testSandbox(t)
	p := filepath.Join(root, "big.txt")
	payload := strings.Repeat("a", maxPreview+80)
	if err := os.WriteFile(p, []byte(payload), 0o644); err != nil {
		t.Fatal(err)
	}
	prev, err := sb.Preview(p)
	if err != nil {
		t.Fatal(err)
	}
	if prev.Kind != "text" || !prev.Truncated {
		t.Fatalf("preview %+v", prev)
	}
	if len(prev.Content) != maxPreview {
		t.Fatalf("content len %d", len(prev.Content))
	}
}
