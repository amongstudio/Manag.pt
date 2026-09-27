package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	fmt.Println("PROGRESS 15")
	roots := os.Args[1:]
	if len(roots) == 0 {
		home, _ := os.UserHomeDir()
		roots = []string{home, os.TempDir()}
	}
	out := make([]map[string]any, 0, len(roots))
	for _, r := range roots {
		abs, err := filepath.Abs(r)
		if err != nil {
			out = append(out, map[string]any{"path": r, "ok": false, "error": err.Error()})
			continue
		}
		info, err := os.Stat(abs)
		if err != nil {
			out = append(out, map[string]any{"path": abs, "ok": false, "error": err.Error()})
			continue
		}
		out = append(out, map[string]any{
			"path": abs,
			"ok":   true,
			"dir":  info.IsDir(),
			"size": info.Size(),
		})
	}
	fmt.Println("PROGRESS 80")
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(map[string]any{"roots": out})
	fmt.Println("PROGRESS 100")
}
