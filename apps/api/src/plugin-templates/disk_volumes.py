import json
import subprocess
import sys

PS = r"""
Get-Volume | Select-Object DriveLetter, FileSystemLabel, FileSystem, HealthStatus, Size, SizeRemaining | ConvertTo-Json -Compress
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
