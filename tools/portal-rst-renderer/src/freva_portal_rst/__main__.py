"""Line-delimited JSON server. One request per line, one response per line."""

from __future__ import annotations

import json
import sys

from .protocol import handshake
from .render import render_source


def main() -> int:
    out = sys.stdout
    out.write(json.dumps(handshake(), sort_keys=True) + "\n")
    out.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            out.write(json.dumps({"error": f"malformed request: {exc}"}) + "\n")
            out.flush()
            continue
        if request.get("op") == "shutdown":
            return 0
        try:
            result = render_source(
                request["source"], request["name"], request.get("profile", {})
            )
        except Exception as exc:  # a helper crash must not look like a clean document
            result = {
                "diagnostics": [
                    {
                        "code": "PC1003",
                        "severity": "error",
                        "message": f"RST helper failure: {type(exc).__name__}: {exc}",
                        "file": request.get("name", "<unknown>"),
                    }
                ]
            }
        out.write(json.dumps(result, sort_keys=True) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
