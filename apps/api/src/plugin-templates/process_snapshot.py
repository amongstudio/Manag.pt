import csv
import io
import json
import os
import subprocess
import sys


def linux_procs(limit):
    out = []
    proc = "/proc"
    if not os.path.isdir(proc):
        return out
    for name in os.listdir(proc):
        if not name.isdigit():
            continue
        stat = os.path.join(proc, name, "stat")
        comm = os.path.join(proc, name, "comm")
        try:
            with open(comm, encoding="utf-8", errors="replace") as f:
                cmd = f.read().strip()
        except OSError:
            continue
        rss = ""
        try:
            with open(stat, encoding="utf-8", errors="replace") as f:
                parts = f.read().split()
                if len(parts) > 23:
                    rss = parts[23]
        except OSError:
            pass
        out.append({"pid": name, "name": cmd, "rssPages": rss})
        if len(out) >= limit:
            break
    return out


def windows_procs(limit):
    try:
        raw = subprocess.check_output(
            ["tasklist", "/fo", "csv", "/nh"],
            text=True,
            errors="replace",
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return [{"error": str(exc)}]
    rows = []
    reader = csv.reader(io.StringIO(raw))
    for row in reader:
        if len(row) < 2:
            continue
        rows.append({"name": row[0], "pid": row[1], "mem": row[4] if len(row) > 4 else ""})
        if len(rows) >= limit:
            break
    return rows


def main() -> None:
    print("PROGRESS 20")
    limit = 50
    if len(sys.argv) > 1:
        try:
            limit = max(1, min(200, int(sys.argv[1])))
        except ValueError:
            pass
    if os.name == "nt":
        procs = windows_procs(limit)
    else:
        procs = linux_procs(limit)
    print("PROGRESS 90")
    print(json.dumps({"count": len(procs), "processes": procs}))
    print("PROGRESS 100")


if __name__ == "__main__":
    main()
