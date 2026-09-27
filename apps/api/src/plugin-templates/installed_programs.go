package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
)

const script = `
$ErrorActionPreference = 'SilentlyContinue'
$keys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)
$rows = foreach ($key in $keys) {
  if (-not (Test-Path $key)) { continue }
  Get-ChildItem $key | ForEach-Object {
    $p = Get-ItemProperty $_.PsPath
    if ($p.DisplayName) {
      [pscustomobject]@{
        name = [string]$p.DisplayName
        version = [string]$p.DisplayVersion
        publisher = [string]$p.Publisher
        installDate = [string]$p.InstallDate
      }
    }
  }
}
@($rows) | ConvertTo-Json -Compress
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
