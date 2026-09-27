import json
import os
import platform
import shutil
import sys
import tempfile


def disk(path):
    try:
        u = shutil.disk_usage(path)
        return {"path": path, "total": u.total, "used": u.used, "free": u.free}
    except OSError:
        return None


def main() -> None:
    print("PROGRESS 20")
    roots = [os.path.expanduser("~"), tempfile.gettempdir()]
    disks = [d for d in (disk(p) for p in roots) if d]
    print("PROGRESS 80")
    print(
        json.dumps(
            {
                "hostname": platform.node(),
                "os": platform.system(),
                "release": platform.release(),
                "arch": platform.machine(),
                "python": sys.version.split()[0],
                "disks": disks,
            }
        )
    )
    print("PROGRESS 100")


if __name__ == "__main__":
    main()
