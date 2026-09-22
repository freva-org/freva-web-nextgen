"""Build the tiny pure-Python wheel the micropip browser test installs.

Committed rather than built during the test run, for the same reason the Zarr fixtures are: a test
that constructs its own input can pass because the constructor and the reader share a mistake, and
a wheel is a format with opinions - RECORD hashes, the WHEEL tag, the dist-info name - that are
worth pinning in a file somebody can unzip and look at.

Deliberately trivial and pure Python. The point of the test is micropip's install path, not
whatever the package does.

    python3 scripts/make-wheel-fixture.py
"""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import pathlib
import zipfile

NAME = "freva_test_pkg"
VERSION = "1.0.0"
DIST_INFO = f"{NAME}-{VERSION}.dist-info"
WHEEL_NAME = f"{NAME}-{VERSION}-py3-none-any.whl"
OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "wheels"

MODULE = '''"""A fixture package. Installed by browser-tests/micropip.mjs and nothing else."""

__version__ = "1.0.0"


def greet(name="world"):
    """Return something the test can compare exactly."""
    return f"hello {name} from an installed wheel"


def add(a, b):
    """Proof that installed code actually executes, not merely imports."""
    return a + b
'''

METADATA = f"""Metadata-Version: 2.1
Name: {NAME.replace("_", "-")}
Version: {VERSION}
Summary: A pure-Python fixture wheel for browser-python's micropip test
License: BSD-3-Clause
Requires-Python: >=3.9
"""

WHEEL = """Wheel-Version: 1.0
Generator: freva-browser-python make-wheel-fixture
Root-Is-Purelib: true
Tag: py3-none-any
"""


def urlsafe_digest(data: bytes) -> str:
    digest = hashlib.sha256(data).digest()
    return "sha256=" + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    entries = [
        (f"{NAME}.py", MODULE.encode()),
        (f"{DIST_INFO}/METADATA", METADATA.encode()),
        (f"{DIST_INFO}/WHEEL", WHEEL.encode()),
    ]

    record = io.StringIO()
    writer = csv.writer(record, lineterminator="\n")
    for path, data in entries:
        writer.writerow([path, urlsafe_digest(data), len(data)])
    writer.writerow([f"{DIST_INFO}/RECORD", "", ""])
    entries.append((f"{DIST_INFO}/RECORD", record.getvalue().encode()))

    target = OUT / WHEEL_NAME
    # Fixed timestamps: a fixture that changes every time it is rebuilt shows up as a diff nobody
    # can review.
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, data in entries:
            info = zipfile.ZipInfo(path, date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)

    print(f"{target.relative_to(OUT.parent.parent.parent)}  {target.stat().st_size} bytes")


if __name__ == "__main__":
    main()
