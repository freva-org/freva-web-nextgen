// `dev` - the same resolver, the same profile, a watcher and a local server. It deliberately
// does not run a second rendering path: rebuilding the whole artifact on change is fast enough
// for a site of this size, and it means what a developer looks at is what CI will produce
// rather than a development-only approximation that diverges quietly.

import { existsSync, mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../artifact/index.js";
import { formatHuman } from "../diagnostics.js";
import { createPreviewServer } from "../verify/preview.js";
import type { CliIo } from "./index.js";

export interface DevOptions {
  sourceRoot: string;
  configPath: string;
  port: number;
  io: CliIo;
}

export async function runDev(options: DevOptions): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), "portal-dev-"));
  const out = join(work, "site");
  let building = false;
  let queued = false;

  const rebuild = async (): Promise<void> => {
    if (building) {
      queued = true;
      return;
    }
    building = true;
    const started = Date.now();
    try {
      const result = await buildSite({
        sourceRoot: options.sourceRoot,
        configPath: options.configPath,
        outDir: out,
        dev: true,
        release: false,
        quiet: true,
      });
      const text = formatHuman(result.diagnostics);
      if (text) options.io.err(`${text}\n`);
      if (result.outDir) {
        options.io.out(`rebuilt in ${Date.now() - started}ms - preview is a non-release build\n`);
      }
    } catch (error) {
      options.io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      building = false;
      if (queued) {
        queued = false;
        void rebuild();
      }
    }
  };

  await rebuild();

  const server = createPreviewServer({ dir: out, port: options.port });
  await new Promise<void>((done) => server.listen(options.port, "127.0.0.1", done));
  options.io.out(`dev: http://127.0.0.1:${options.port}/ (non-release preview)\n`);

  if (existsSync(options.sourceRoot)) {
    watch(options.sourceRoot, { recursive: true }, (_event, filename) => {
      if (typeof filename === "string" && filename.includes("node_modules")) return;
      void rebuild();
    });
  }

  await new Promise(() => undefined);
  rmSync(work, { recursive: true, force: true });
  return 0;
}
