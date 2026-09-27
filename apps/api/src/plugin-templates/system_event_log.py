import json
import subprocess
import sys

PS = r"""
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
