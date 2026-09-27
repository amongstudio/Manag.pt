package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strconv"
)

func main() {
	fmt.Println("PROGRESS 20")
	limit := 50
	if len(os.Args) > 1 {
		if n, err := strconv.Atoi(os.Args[1]); err == nil && n > 0 {
			limit = n
			if limit > 200 {
				limit = 200
			}
		}
	}
	entries, err := os.ReadDir("/proc")
	procs := make([]map[string]string, 0, 32)
	if err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			name := e.Name()
			if name == "" || name[0] < '0' || name[0] > '9' {
				continue
			}
			comm, err := os.ReadFile("/proc/" + name + "/comm")
			if err != nil {
				continue
			}
			procs = append(procs, map[string]string{"pid": name, "name": string(bytesTrim(comm))})
			if len(procs) >= limit {
				break
			}
		}
	}
	fmt.Println("PROGRESS 90")
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(map[string]any{
		"os":        runtime.GOOS,
		"count":     len(procs),
		"processes": procs,
	})
	fmt.Println("PROGRESS 100")
}

func bytesTrim(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}
