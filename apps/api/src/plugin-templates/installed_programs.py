import json
import subprocess
import sys

PS = r"""
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
"""


def main() -> None:
    print("PROGRESS 20")
    try:
        raw = subprocess.check_output(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", PS],
            text=True,
            errors="replace",
            timeout=25,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
    print("PROGRESS 90")
    print(raw.strip() or "[]")
    print("PROGRESS 100")


if __name__ == "__main__":
    main()
