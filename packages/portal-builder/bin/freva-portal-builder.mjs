#!/usr/bin/env node
/**
 * The `freva-portal-builder` executable. The name is distinct from `freva-portal` so the
 * two can coexist on a developer's PATH without shadowing one another.
 */
import { run } from "../dist/index.js";

process.exitCode = await run(process.argv.slice(2));
