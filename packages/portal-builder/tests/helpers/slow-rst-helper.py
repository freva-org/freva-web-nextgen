#!/usr/bin/env python3
"""A deliberately slow stand-in for the RST helper, used by one test.

It answers the handshake immediately and then delays its first render response
past the caller's timeout. The second request is answered at once. A client that
did not poison the stream after a timeout would hand the late first answer to the
second request.
"""
import json
import sys
import time

HANDSHAKE = json.loads(sys.argv[1])
DELAY = float(sys.argv[2])

sys.stdout.write(json.dumps(HANDSHAKE) + "\n")
sys.stdout.flush()

seen = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    if request.get("op") == "shutdown":
        break
    seen += 1
    if seen == 1:
        time.sleep(DELAY)
    sys.stdout.write(
        json.dumps({"name": request.get("name"), "answeredRequest": seen, "diagnostics": []}) + "\n"
    )
    sys.stdout.flush()
