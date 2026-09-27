package filemanager

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	maxList      = 500
	maxSearch    = 500
	maxContentMB = 1 << 20
	maxLineHits  = 5
	maxPreview   = 64 << 10
)

type Entry struct {
	Name  string    `json:"name"`
	Path  string    `json:"path"`
	Dir   bool      `json:"dir"`
	Size  int64     `json:"size"`
	Mode  string    `json:"mode"`
	Mtime time.Time `json:"mtime"`
}

type ListResult struct {
	Path      string   `json:"path"`
	Roots     []string `json:"roots"`
	Truncated bool     `json:"truncated"`
	Entries   []Entry  `json:"entries"`
}

type Preview struct {
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Mime      string `json:"mime,omitempty"`
	Encoding  string `json:"encoding,omitempty"`
	Truncated bool   `json:"truncated"`
	Size      int64  `json:"size"`
	Content   string `json:"content,omitempty"`
}

type SearchHit struct {
	Name    string   `json:"name"`
	Path    string   `json:"path"`
	Dir     bool     `json:"dir"`
	Size    int64    `json:"size"`
	Matches []string `json:"matches,omitempty"`
}

type Sandbox struct {
	roots []string
	deny  []string
}

func New(extra []string, denyRoots ...string) *Sandbox {
	home, _ := os.UserHomeDir()
	roots := []string{canonicalize(home), canonicalize(os.TempDir())}
	if p := extraHomeDir(); p != "" {
		c := canonicalize(p)
		if c != "" && foldPath(c) != foldPath(canonicalize(home)) {
			roots = append(roots, c)
		}
	}
	for _, r := range extra {
		if r == "" {
			continue
		}
		roots = append(roots, canonicalize(r))
	}
	deny := make([]string, 0, len(denyRoots))
	for _, r := range denyRoots {
		if r == "" {
			continue
		}
		deny = append(deny, canonicalize(r))
	}
	return &Sandbox{roots: roots, deny: deny}
}

func foldPath(p string) string {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.ToLower(p)
	}
	return p
}

func canonicalize(p string) string {
	if p == "" {
		return p
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	clean := filepath.Clean(abs)
	if eval, err := filepath.EvalSymlinks(clean); err == nil {
		return eval
	}
	dir, base := filepath.Split(clean)
	if dir != "" {
		if evalDir, err := filepath.EvalSymlinks(dir); err == nil {
			return filepath.Join(evalDir, base)
		}
	}
	return clean
}

func sandboxContains(candidate, root string) bool {
	if candidate == "" || root == "" {
		return false
	}
	c := foldPath(candidate)
	r := foldPath(root)
	if c == r {
		return true
	}
	sep := string(filepath.Separator)
	rootPrefix := r
	if !strings.HasSuffix(r, sep) {
		rootPrefix = r + sep
	}
	return strings.HasPrefix(c, rootPrefix)
}

func (s *Sandbox) Resolve(p string) (string, error) {
	if p == "" {
		return "", errors.New("empty path")
	}
	if hasDotDotSegment(p) {
		return "", errors.New("path traversal denied")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	clean := filepath.Clean(abs)
	if hasDotDotSegment(clean) {
		return "", errors.New("path traversal denied")
	}
	candidate := canonicalize(clean)
	if hasDotDotSegment(candidate) {
		return "", errors.New("path traversal denied")
	}
	for _, denied := range s.deny {
		if sandboxContains(candidate, denied) {
			return "", errors.New("path denied")
		}
	}
	lower := strings.ToLower(candidate)
	deny := []string{"windows\\system32\\config", "/etc/shadow", "/etc/passwd"}
	for _, d := range deny {
		if strings.Contains(lower, strings.ToLower(filepath.FromSlash(d))) {
			return "", errors.New("path denied")
		}
	}
	for _, root := range s.roots {
		root = canonicalize(root)
		if sandboxContains(candidate, root) {
			return candidate, nil
		}
	}
	return "", errors.New("path outside sandbox")
}

func hasDotDotSegment(p string) bool {
	normalized := strings.ReplaceAll(p, "\\", "/")
	for _, seg := range strings.Split(normalized, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

func (s *Sandbox) Roots() []string {
	out := make([]string, len(s.roots))
	copy(out, s.roots)
	return out
}

func (s *Sandbox) List(p string) (ListResult, error) {
	if p == "" {
		home, _ := os.UserHomeDir()
		p = home
	}
	resolved, err := s.Resolve(p)
	if err != nil {
		return ListResult{}, err
	}
	entries, err := os.ReadDir(resolved)
	if err != nil {
		return ListResult{}, err
	}
	out := make([]Entry, 0, len(entries))
	truncated := false
	for _, e := range entries {
		if len(out) >= maxList {
			truncated = true
			break
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, Entry{
			Name:  e.Name(),
			Path:  filepath.Join(resolved, e.Name()),
			Dir:   e.IsDir() || info.Mode()&fs.ModeDir != 0,
			Size:  info.Size(),
			Mode:  info.Mode().String(),
			Mtime: info.ModTime().UTC(),
		})
	}
	if !truncated && len(entries) > len(out) && len(out) >= maxList {
		truncated = true
	}
	return ListResult{Path: resolved, Roots: s.Roots(), Truncated: truncated, Entries: out}, nil
}

func (s *Sandbox) Delete(p string) error {
	resolved, err := s.Resolve(p)
	if err != nil {
		return err
	}
	for _, root := range s.roots {
		if foldPath(canonicalize(root)) == foldPath(resolved) {
			return errors.New("cannot delete sandbox root")
		}
	}
	return os.RemoveAll(resolved)
}

func (s *Sandbox) Mkdir(p string) error {
	resolved, err := s.Resolve(p)
	if err != nil {
		return err
	}
	return os.MkdirAll(resolved, 0o755)
}

func (s *Sandbox) Rename(from, to string) error {
	src, err := s.Resolve(from)
	if err != nil {
		return err
	}
	dst, err := s.Resolve(to)
	if err != nil {
		return err
	}
	return os.Rename(src, dst)
}

func (s *Sandbox) Copy(from, to string) error {
	src, err := s.Resolve(from)
	if err != nil {
		return err
	}
	dst, err := s.Resolve(to)
	if err != nil {
		return err
	}
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errors.New("cannot copy directory")
	}
	if foldPath(src) == foldPath(dst) {
		return nil
	}
	return CopyFile(src, dst)
}

func (s *Sandbox) Preview(p string) (*Preview, error) {
	resolved, err := s.Resolve(p)
	if err != nil {
		return nil, err
	}
	return PreviewFile(resolved)
}

func PreviewFile(resolved string) (*Preview, error) {
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, errors.New("not a file")
	}
	ext := strings.ToLower(filepath.Ext(resolved))
	out := &Preview{Path: resolved, Size: info.Size()}
	if imageExt[ext] {
		if info.Size() > maxPreview {
			out.Kind = "unsupported"
			return out, nil
		}
		data, err := os.ReadFile(resolved)
		if err != nil {
			return nil, err
		}
		if int64(len(data)) > maxPreview {
			out.Kind = "unsupported"
			return out, nil
		}
		out.Kind = "image"
		out.Mime = imageMime(ext)
		out.Encoding = "base64"
		out.Content = base64.StdEncoding.EncodeToString(data)
		return out, nil
	}
	f, err := os.Open(resolved)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, maxPreview+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, err
	}
	truncated := n > maxPreview
	if truncated {
		buf = buf[:maxPreview]
	} else {
		buf = buf[:n]
	}
	if !looksText(buf) && !textExt[ext] {
		out.Kind = "unsupported"
		out.Truncated = truncated
		return out, nil
	}
	out.Kind = "text"
	out.Mime = "text/plain"
	out.Encoding = "utf8"
	out.Truncated = truncated
	out.Content = string(buf)
	return out, nil
}

func looksText(b []byte) bool {
	if bytes.IndexByte(b, 0) >= 0 {
		return false
	}
	return true
}

func imageMime(ext string) string {
	switch ext {
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".ico":
		return "image/x-icon"
	default:
		return "image/jpeg"
	}
}

func (s *Sandbox) Move(from, to string) error {
	src, err := s.Resolve(from)
	if err != nil {
		return err
	}
	dst, err := s.Resolve(to)
	if err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errors.New("cannot move directory across volumes")
	}
	if err := CopyFile(src, dst); err != nil {
		return err
	}
	return os.Remove(src)
}

func CopyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

var textExt = map[string]bool{
	".txt": true, ".log": true, ".md": true, ".json": true, ".xml": true,
	".yml": true, ".yaml": true, ".csv": true, ".ini": true, ".cfg": true,
	".conf": true, ".ps1": true, ".sh": true, ".bat": true, ".js": true,
	".ts": true, ".py": true, ".go": true, ".css": true, ".html": true,
	".env": true, ".toml": true,
}

var imageExt = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
	".bmp": true, ".ico": true,
}

func (s *Sandbox) Search(root, name, ext, content string) ([]SearchHit, error) {
	if root == "" {
		home, _ := os.UserHomeDir()
		root = home
	}
	resolved, err := s.Resolve(root)
	if err != nil {
		return nil, err
	}
	nameQ := strings.ToLower(strings.TrimSpace(name))
	extQ := strings.ToLower(strings.TrimSpace(ext))
	if extQ != "" && !strings.HasPrefix(extQ, ".") {
		extQ = "." + extQ
	}
	contentQ := strings.ToLower(strings.TrimSpace(content))
	hits := make([]SearchHit, 0, 32)
	err = filepath.WalkDir(resolved, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if _, err := s.Resolve(path); err != nil {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		base := d.Name()
		lower := strings.ToLower(base)
		if nameQ != "" && !strings.Contains(lower, nameQ) {
			return nil
		}
		if extQ != "" && !d.IsDir() && filepath.Ext(lower) != extQ {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		hit := SearchHit{Name: base, Path: path, Dir: d.IsDir(), Size: info.Size()}
		if contentQ != "" && !d.IsDir() && info.Size() <= maxContentMB && textExt[filepath.Ext(lower)] {
			hit.Matches = contentMatches(path, contentQ)
			if len(hit.Matches) == 0 {
				return nil
			}
		} else if contentQ != "" {
			return nil
		}
		hits = append(hits, hit)
		if len(hits) >= maxSearch {
			return errors.New("search cap")
		}
		return nil
	})
	if err != nil && err.Error() != "search cap" {
		return hits, err
	}
	return hits, nil
}

func contentMatches(path, needle string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	scanner := bufio.NewScanner(io.LimitReader(f, maxContentMB))
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 256*1024)
	out := make([]string, 0, maxLineHits)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(strings.ToLower(line), needle) {
			if len(line) > 240 {
				line = line[:240]
			}
			out = append(out, line)
			if len(out) >= maxLineHits {
				break
			}
		}
	}
	return out
}
