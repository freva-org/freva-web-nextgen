// JupyterLab smoke test: the pip packages, installed into a real JupyterLab, load beside
// jupyterlite-ai, and their plugins activate - the provider is registered and the data panel is
// there. Two environments: JupyterLab 4.5.0 with jupyterlite-ai 0.20.1 (its own minimum) and both
// extensions, and JupyterLab 4.4.0 with the data panel alone (it needs no jupyterlite-ai).
//
// Needs Python 3.10+ and the network (PyPI) the first time; environments are cached under
// .jupyterlab-env-*/ in this package.
//
//   node browser-tests/jupyterlab-smoke.mjs
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXIT_NOT_RUN,
  STRICT,
  launch,
  report,
} from "../../jupyterlite-freva-kernel/browser-tests/lite-harness.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKG = resolve(HERE, "..");
const DATA_PKG = resolve(PKG, "..", "jupyterlite-freva-data");
const PYTHON = process.env.FREVA_PYTHON ?? "python3";
const checks = [];
const check = (name, pass, detail = "") =>
  checks.push({ name, pass: Boolean(pass), detail: pass ? "" : String(detail).slice(0, 800) });

function sh(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

/** Our two wheels, built from the packages' prebuilt extensions (hatchling, from PyPI). */
function buildWheels() {
  const out = mkdtempSync(join(tmpdir(), "freva-wheels-"));
  for (const dir of [PKG, DATA_PKG]) {
    if (!existsSync(join(dir, "labextension", "package.json"))) {
      throw new Error(
        `${dir}: build the extension first (npm run build && npm run build:labextension)`,
      );
    }
    sh(PYTHON, [
      "-m",
      "pip",
      "wheel",
      "--no-deps",
      "--disable-pip-version-check",
      "-q",
      "-w",
      out,
      dir,
    ]);
  }
  return readdirSync(out)
    .filter((f) => f.endsWith(".whl"))
    .map((f) => join(out, f));
}

function environment(name, packages, wheels) {
  const env = join(PKG, `.jupyterlab-env-${name}`);
  const bin = join(env, "bin");
  if (!existsSync(join(env, ".complete"))) {
    sh(PYTHON, ["-m", "venv", env]);
    sh(join(bin, "python"), [
      "-m",
      "pip",
      "install",
      "-q",
      "--disable-pip-version-check",
      "--only-binary=:all:",
      ...packages,
    ]);
    writeFileSync(join(env, ".complete"), "ok\n");
  }
  // Our wheels are reinstalled every run: they are what is under test.
  sh(join(bin, "python"), [
    "-m",
    "pip",
    "install",
    "-q",
    "--disable-pip-version-check",
    "--force-reinstall",
    "--no-deps",
    ...wheels,
  ]);
  return { env, bin };
}

function startStatic(json) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(json);
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }),
    ),
  );
}

async function startLab(bin, settingsDir) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const lab = spawn(
    join(bin, "jupyter"),
    [
      "lab",
      "--no-browser",
      `--port=${port}`,
      "--ServerApp.ip=127.0.0.1",
      "--allow-root",
      "--IdentityProvider.token=",
      "--ServerApp.password=",
      "--ServerApp.disable_check_xsrf=True",
      "--LabApp.expose_app_in_browser=True",
      `--ServerApp.root_dir=${mkdtempSync(join(tmpdir(), "freva-lab-root-"))}`,
    ],
    {
      env: {
        ...process.env,
        JUPYTERLAB_SETTINGS_DIR: settingsDir,
        JUPYTER_CONFIG_DIR: mkdtempSync(join(tmpdir(), "freva-lab-config-")),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  lab.stdout.on("data", (d) => (log += d));
  lab.stderr.on("data", (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`${url}/api/status`);
      if (response.ok) return { url, stop: () => lab.kill("SIGTERM"), log: () => log };
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  lab.kill("SIGTERM");
  throw new Error(`JupyterLab did not start:\n${log.slice(-2000)}`);
}

const PANEL_DATA = JSON.stringify({
  schemaVersion: 1,
  instanceId: "home-0",
  mode: "snapshot",
  catalog: {
    schemaVersion: 1,
    roots: [
      {
        id: "c",
        kind: "collection",
        name: "c",
        title: "Smoke archive",
        children: [{ id: "d", kind: "dataset", name: "d.zarr" }],
      },
    ],
  },
  expand: [],
  statusLabel: "SNAPSHOT",
  examples: [],
  recipes: [],
});

async function smoke(label, { bin, overridesFor, plugins, expectProvider }) {
  const data = await startStatic(PANEL_DATA);
  const overrides = overridesFor(data.url);
  writeFileSync(
    join(bin, "..", "share", "jupyter", "lab", "settings", "overrides.json"),
    JSON.stringify(overrides, null, 2),
  );
  const settingsDir = mkdtempSync(join(tmpdir(), "freva-lab-user-"));
  const lab = await startLab(bin, settingsDir);
  const run = spawnSync(join(bin, "jupyter"), ["labextension", "list"], { encoding: "utf8" });
  // eslint-disable-next-line no-control-regex
  const listed = `${run.stdout}${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  const browser = await launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${lab.url}/lab`);
    await page.waitForFunction(() => window.jupyterapp?.started !== undefined, null, {
      timeout: 90_000,
    });
    await page.evaluate(() => window.jupyterapp.restored);
    await page.waitForTimeout(2000);
    for (const id of plugins) {
      const active = await page.evaluate((pid) => window.jupyterapp.isPluginActivated(pid), id);
      check(`${label}: ${id} is active`, active, errors.join("\n"));
    }
    const failed = errors.filter(
      (e) =>
        /failed to activate|No provider for/i.test(e) &&
        /freva|climateclaw|jupyternaut|jupyterlite\/ai/i.test(e),
    );
    check(
      `${label}: no plugin of ours or jupyterlite-ai failed`,
      failed.length === 0,
      failed.join("\n"),
    );
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll(".jp-SideBar.jp-mod-left .lm-TabBar-tab")].map(
        (t) => t.getAttribute("title") ?? "",
      ),
    );
    check(
      `${label}: the data panel is in the left side bar`,
      tabs.some((t) => t.startsWith("Smoke data")),
      JSON.stringify(tabs),
    );
    await page.locator('.jp-SideBar.jp-mod-left .lm-TabBar-tab[title^="Smoke data"]').click();
    await page.locator(".jp-FrevaData", { hasText: "Smoke archive" }).waitFor({ timeout: 20_000 });
    check(`${label}: the panel shows its tree`, true);
    if (expectProvider) {
      await page.locator('.jp-SideBar.jp-mod-left .lm-TabBar-tab[title^="Chat"]').click();
      await page
        .locator('[id="@jupyterlite/ai:chat-panel"]', { hasText: "ClimateClaw (Freva)" })
        .waitFor({ timeout: 20_000 });
      check(`${label}: the ClimateClaw chat opens with its provider`, true);
      // The header's model chip stands in for jupyterlite-ai's picker when every provider is
      // ClimateClaw (it may sit in the header's overflow popup, so read it attached).
      const chip = page.locator(".jp-ClimateClaw-modelChip-button").first();
      await chip.waitFor({ state: "attached", timeout: 20_000 });
      const model = await chip.getAttribute("data-model");
      check(
        `${label}: the header's model chip shows ClimateClaw's default model`,
        model === "gpt-test",
        model,
      );
      check(
        `${label}: …in place of jupyterlite-ai's picker`,
        (await page.locator('button[title="Select AI Model"]:visible').count()) === 0,
      );
      check(
        `${label}: the account control is in the chat toolbar`,
        (await page.locator('[data-command="climateclaw:account"]').count()) > 0,
      );
    }
    check(
      `${label}: jupyter labextension list shows ours enabled and OK (no compatibility warning)`,
      /@freva-org\/jupyterlite-freva-data v\S+ enabled\s+OK/.test(listed) &&
        (!expectProvider || /@freva-org\/jupyterlite-climateclaw v\S+ enabled\s+OK/.test(listed)),
      listed,
    );
  } finally {
    await browser.close();
    lab.stop();
    data.close();
  }
}

let wheels;
try {
  wheels = buildWheels();
} catch (error) {
  console.error(`The wheels could not be built: ${error.message}`);
  process.exit(STRICT ? 1 : EXIT_NOT_RUN);
}
const climateWheel = wheels.find((w) => /jupyterlite_climateclaw/.test(w));
const dataWheel = wheels.find((w) => /jupyterlite_freva_data/.test(w));

const panelOverride = (url) => ({
  "@freva-org/jupyterlite-freva-data:plugin": {
    siteName: "Smoke",
    dataUrl: `${url}/panel.json`,
    kernelName: "python3",
  },
});

try {
  const full = environment(
    "4.5.0",
    ["jupyterlab==4.5.0", "jupyterlite-ai==0.20.1"],
    [climateWheel, dataWheel],
  );
  mkdirSync(join(full.env, "share", "jupyter", "lab", "settings"), { recursive: true });
  await smoke("JupyterLab 4.5.0 + jupyterlite-ai 0.20.1", {
    bin: full.bin,
    expectProvider: true,
    plugins: [
      "@freva-org/jupyterlite-climateclaw:plugin",
      "@freva-org/jupyterlite-climateclaw:auth",
      "@freva-org/jupyterlite-climateclaw:provider",
      "@freva-org/jupyterlite-climateclaw:chat",
      "@freva-org/jupyterlite-climateclaw:run-and-fix",
      "@freva-org/jupyterlite-freva-data:plugin",
    ],
    overridesFor: (url) => ({
      ...panelOverride(url),
      "@jupyternaut/persona:settings-model": {
        providers: [
          {
            id: "climateclaw",
            name: "ClimateClaw (Freva)",
            provider: "climateclaw",
            model: "gpt-test",
          },
        ],
        defaultProvider: "climateclaw",
        useSameProviderForChatAndCompleter: false,
        useSecretsManager: false,
        toolsEnabled: false,
      },
      "@freva-org/jupyterlite-climateclaw:plugin": {
        host: "https://freva.example.org",
        defaultModel: "gpt-test",
      },
    }),
  });
  const lean = environment("4.4.0", ["jupyterlab==4.4.0"], [dataWheel]);
  mkdirSync(join(lean.env, "share", "jupyter", "lab", "settings"), { recursive: true });
  await smoke("JupyterLab 4.4.0, data panel alone", {
    bin: lean.bin,
    expectProvider: false,
    plugins: ["@freva-org/jupyterlite-freva-data:plugin"],
    overridesFor: panelOverride,
  });
} catch (error) {
  check("the JupyterLab environments", false, error.stack ?? error);
}

process.exit(report("JupyterLab smoke test", checks));
