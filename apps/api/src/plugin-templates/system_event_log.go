package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
)

const script = `
Get-WinEvent -LogName System -MaxEvents 50 -ErrorAction Stop | ForEach-Object {
  $msg = [string]$_.Message
  if ($msg.Length -gt 400) { $msg = $msg.Substring(0, 400) }
  [pscustomobject]@{
    time = $_.TimeCreated.ToString('o')
    type = [string]$_.LevelDisplayName
    source = [string]$_.ProviderName
    id = $_.Id
    message = $msg
  }
} | ConvertTo-Json -Compress
`

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
