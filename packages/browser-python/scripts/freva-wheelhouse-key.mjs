#!/usr/bin/env node
// The cache id for the derived Freva wheel: a digest of everything that decides its bytes.
//
// Keyed on the PINS AND THE TRANSFORM, not on the lockfile. A pin change, a new runtime pin or an
// edit to the overlay all produce a different wheel, and a cache keyed on anything looser would
// restore a wheel built before the change - which is the failure mode that hides itself, because
// the stale wheel installs perfectly well.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const parts = ["bin/freva-wheelhouse.json", "bin/freva-wheelhouse.mjs", "bin/zip.mjs"];
const hash = createHash("sha256");
for (const part of parts) hash.update(readFileSync(join(PKG, part)));
process.stdout.write(`${hash.digest("hex").slice(0, 32)}\n`);
