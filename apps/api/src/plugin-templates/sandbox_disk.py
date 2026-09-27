import json
import os
import shutil
import sys
import tempfile


def usage(path):
    try:
        u = shutil.disk_usage(path)
        return {"path": path, "total": u.total, "used": u.used, "free": u.free, "ok": True}
    except OSError as exc:
        return {"path": path, "ok": False, "error": str(exc)}


def main() -> None:
    print("PROGRESS 15")
    roots = sys.argv[1:] or [os.path.expanduser("~"), tempfile.gettempdir()]
    print("PROGRESS 60")
    print(json.dumps({"roots": [usage(p) for p in roots]}))
    print("PROGRESS 100")


if __name__ == "__main__":
    main()
