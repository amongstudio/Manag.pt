package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
)

func main() {
	fmt.Println("PROGRESS 20")
	host, _ := os.Hostname()
	fmt.Println("PROGRESS 80")
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(map[string]any{
		"hostname": host,
		"os":       runtime.GOOS,
		"arch":     runtime.GOARCH,
		"cpus":     runtime.NumCPU(),
	})
	fmt.Println("PROGRESS 100")
}
