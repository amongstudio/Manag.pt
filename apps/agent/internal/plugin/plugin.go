package plugin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pc-manager/agent/internal/client"
)

const stdoutCap = 65536

type Request struct {
	PluginID string
	Args     []string
	Client   *client.Client
	DataDir  string
	Progress func(int)
}

func Run(req Request) (any, error) {
	if strings.TrimSpace(req.PluginID) == "" {
		return nil, errors.New("pluginId required")
	}
	if req.Client == nil {
		return nil, errors.New("plugin client required")
	}
	if req.Progress != nil {
		req.Progress(5)
	}
	meta, err := req.Client.PluginMeta(req.PluginID)
	if err != nil {
		return nil, err
	}
	if meta.Runtime == "js_goja" {
		return map[string]any{"runtime": meta.Runtime}, errors.New("js_goja runtime is not implemented")
	}
	if req.Progress != nil {
		req.Progress(15)
	}
	blob, err := cachedBlob(req.DataDir, meta, req.Client)
	if err != nil {
		return nil, err
	}
	if req.Progress != nil {
		req.Progress(40)
	}
	timeout := time.Duration(meta.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return execPlugin(ctx, meta, blob, req.Args, req.Progress)
}

func cachedBlob(dataDir string, meta *client.PluginMeta, c *client.Client) ([]byte, error) {
	dir := filepath.Join(dataDir, "plugins")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	cachePath := filepath.Join(dir, fmt.Sprintf("%s-%s", sanitizeID(meta.ID), shortHash(meta.SHA256)))
	if data, err := os.ReadFile(cachePath); err == nil {
		if strings.EqualFold(sha256Hex(data), meta.SHA256) {
			return data, nil
		}
		_ = os.Remove(cachePath)
	}
	tmp := cachePath + ".part"
	if err := c.DownloadPlugin(meta.ID, tmp, int64(meta.Size)); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	data, err := os.ReadFile(tmp)
	if err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	if !strings.EqualFold(sha256Hex(data), meta.SHA256) {
		_ = os.Remove(tmp)
		return nil, errors.New("plugin sha256 mismatch")
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	if err := os.Rename(tmp, cachePath); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	return data, nil
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func sanitizeID(id string) string {
	var b strings.Builder
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if out == "" {
		return "plugin"
	}
	return out
}

func shortHash(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	if len(h) > 16 {
		return h[:16]
	}
	if h == "" {
		return "unknown"
	}
	return h
}

func parseProgress(line string) (int, bool) {
	line = strings.TrimSpace(line)
	const prefix = "::progress "
	if !strings.HasPrefix(line, prefix) {
		return 0, false
	}
	n := 0
	for _, r := range strings.TrimSpace(line[len(prefix):]) {
		if r < '0' || r > '9' {
			return 0, false
		}
		n = n*10 + int(r-'0')
		if n > 100 {
			n = 100
		}
	}
	return n, true
}

func ArgsFrom(v any) []string {
	switch t := v.(type) {
	case []string:
		return t
	case []any:
		out := make([]string, 0, len(t))
		for _, x := range t {
			if s, ok := x.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	case string:
		if strings.TrimSpace(t) == "" {
			return nil
		}
		return strings.Fields(t)
	default:
		return nil
	}
}
