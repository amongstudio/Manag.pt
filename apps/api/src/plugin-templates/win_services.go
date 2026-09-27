package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
)

const script = `Get-Service | Select-Object Name, Status, StartType, DisplayName | ConvertTo-Json -Compress`

func main() {
	fmt.Println("PROGRESS 20")
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	out, err := cmd.Output()
	if err != nil {
		enc := json.NewEncoder(os.Stdout)
		_ = enc.Encode(map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	fmt.Println("PROGRESS 90")
	os.Stdout.Write(out)
	if len(out) == 0 || out[len(out)-1] != '\n' {
		fmt.Println()
	}
	fmt.Println("PROGRESS 100")
}
