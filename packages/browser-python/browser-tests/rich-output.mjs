// The DOM boundary for Python-authored markup, in a REAL parser:
// `@freva-org/browser-python/display` renders a hostile corpus and nothing may run, load,
// navigate, clobber or keep a style. No interpreter - the payloads are what a visitor's Python
// could publish - so it runs in every engine.
import { bundleDisplay, inBrowser, report, requireDist, serve } from "./harness.mjs";

requireDist();
const DISPLAY = bundleDisplay();

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>rich output</title></head>
<body><div id="out"></div>
<script type="module">
  import * as display from "${DISPLAY}";
  window.__display = display;
  window.__ready = true;
</script></body></html>`;

/** Each entry is HTML a visitor's Python could publish. None of it may act. */
const HOSTILE = [
  `<img src=x onerror="window.__pwned='img'">`,
  `<svg><script>window.__pwned='svg-script'</script></svg>`,
  `<math><mtext><table><mglyph><style><img src=x onerror="window.__pwned='mxss'"></style></mglyph></table></mtext></math>`,
  `<noscript><p title="</noscript><img src=x onerror=window.__pwned='noscript'>"></p></noscript>`,
  `<a href="javascript:window.__pwned='js-url'" id="jsa">click</a>`,
  `<a href="  JaVaScRiPt:window.__pwned='js-url2'">x</a>`,
  `<iframe srcdoc="<script>parent.__pwned='srcdoc'</script>"></iframe>`,
  `<object data="https://example.org/x"></object><embed src="https://example.org/x">`,
  `<form action="https://example.org/"><button formaction="https://example.org/">b</button><input name="q"></form>`,
  `<meta http-equiv="refresh" content="0;url=https://example.org/"><base href="https://example.org/">`,
  `<link rel="stylesheet" href="https://example.org/x.css"><style>@import url(https://example.org/y.css); body{display:none}</style>`,
  `<div style="background:url(https://example.org/bg.png)">styled</div>`,
  `<img srcset="https://example.org/2x.png 2x" src="data:image/png;base64,iVBORw0KGgo=">`,
  `<video poster="https://example.org/p.png"></video><audio src="https://example.org/a.mp3"></audio>`,
  `<svg><image href="https://example.org/i.png"/><use href="https://example.org/s.svg#a"/><use xlink:href="data:image/svg+xml,x"/></svg>`,
  `<svg><foreignObject><img src=x onerror="window.__pwned='fo'"></foreignObject></svg>`,
  `<svg><animate onbegin="window.__pwned='animate'" attributeName="x" dur="1s"/><set attributeName="href" to="javascript:alert(1)"/></svg>`,
  `<input autofocus onfocus="window.__pwned='focus'"><details open ontoggle="window.__pwned='toggle'"><summary>s</summary></details>`,
  `<template><script>window.__pwned='template'</script></template>`,
  `<form id="cookie"></form><img name="getElementById"><p id="__proto__">clobber</p>`,
  `<div onclick="window.__pwned='click'" id="clickme">click me</div>`,
  `<svg><rect width="4" height="4" fill="url(https://example.org/p.svg#p)" stroke="url(https://example.org/s.svg#s)" clip-path="url(https://example.org/c.svg#c)" mask="url(https://example.org/m.svg#m)" marker-end="url(https://example.org/k.svg#k)"/></svg>`,
];

const result = await inBrowser(async (page) => {
  const server = await serve(PAGE);
  const checks = [];
  const check = (name, pass, detail) =>
    checks.push({
      name,
      pass: Boolean(pass),
      ...(detail !== undefined ? { detail: String(detail).slice(0, 300) } : {}),
    });
  const foreign = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(server.url) && !/^(blob|data):/.test(r.url())) foreign.push(r.url());
  });
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });

    const rendered = await page.evaluate(async (corpus) => {
      const out = document.getElementById("out");
      const urls = [];
      const ctx = { document, track: (u) => urls.push(u) };
      window.__display.adoptDisplayStyles(document);
      for (const html of corpus) {
        out.append(
          window.__display.renderBundle(
            { "text/plain": "fallback", "text/html": html },
            undefined,
            ctx,
          ),
        );
      }
      // Give anything that would fire - error handlers, autofocus, animations - its chance.
      document.getElementById("clickme")?.click();
      for (const a of out.querySelectorAll("a")) a.click();
      await new Promise((r) => setTimeout(r, 1500));
      return {
        html: out.innerHTML,
        pwned: window.__pwned ?? null,
        location: location.href,
        cookieClobbered: typeof document.cookie !== "string",
        getElementById: typeof document.getElementById,
        styles: document.querySelectorAll("#out style, #out [style], #out link").length,
        urls,
      };
    }, HOSTILE);
    check("nothing in the hostile corpus ran", rendered.pwned === null, rendered.pwned);
    check(
      "…or navigated the page",
      rendered.location === new URL(server.url).href,
      rendered.location,
    );
    check(
      "…or clobbered document properties",
      !rendered.cookieClobbered && rendered.getElementById === "function",
    );
    check(
      "no script, handler, frame, form control (but checkboxes), meta, base, embed or javascript: URL survived",
      !/<script|\son[a-z]+=|<iframe|<object|<embed|<form|<button|<meta|<base|<template|javascript:|<video|<audio|<animate|<set\b|<image|foreignObject/i.test(
        rendered.html,
      ),
      rendered.html,
    );
    check("no <style>, <link> or style attribute survived", rendered.styles === 0, rendered.styles);
    check(
      "ids are namespaced, never the page's own",
      !/id="(cookie|__proto__|clickme|jsa)"/.test(rendered.html) &&
        /id="fv[a-z0-9]+-clickme"/.test(rendered.html),
      rendered.html.match(/id="[^"]*"/g)?.join(" "),
    );
    check(
      "the harmless text survived",
      /styled/.test(rendered.html) && /clobber/.test(rendered.html),
      rendered.html,
    );

    // SVG and PNG: images, never inline markup, revoked by the caller.
    const images = await page.evaluate(async () => {
      const urls = [];
      const ctx = { document, track: (u) => urls.push(u) };
      const svg = window.__display.renderBundle(
        {
          "text/plain": "s",
          "image/svg+xml": `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="window.__pwned='svgload'"><script>window.__pwned='svg'</script><rect width="5" height="5"/><image href="https://example.org/x.png"/></svg>`,
        },
        undefined,
        ctx,
      );
      document.body.append(svg);
      const img = svg.querySelector("img");
      await new Promise((resolve) => {
        if (img.complete) resolve();
        img.onload = img.onerror = resolve;
      });
      const svgText = await (await fetch(img.src)).text();
      // A PNG claiming 20000 x 20000 pixels: refused from its header, never decoded.
      const header = new Uint8Array(33);
      header.set([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      ]);
      new DataView(header.buffer).setUint32(16, 20000);
      new DataView(header.buffer).setUint32(20, 20000);
      const bomb = window.__display.renderPng(btoa(String.fromCharCode(...header)), ctx);
      for (const u of urls) URL.revokeObjectURL(u);
      let revoked = false;
      try {
        await fetch(urls[0]);
      } catch {
        revoked = true;
      }
      return {
        inline: svg.querySelector("svg") !== null,
        natural: img.naturalWidth,
        svgText,
        bomb: bomb?.textContent ?? null,
        tracked: urls.length,
        revoked,
        pwned: window.__pwned ?? null,
      };
    });
    check(
      "an SVG is shown as an image, not inline",
      !images.inline && images.natural === 10,
      JSON.stringify(images),
    );
    check(
      "…reduced to its safe subset",
      /<rect/.test(images.svgText) && !/script|onload|<image|example\.org/.test(images.svgText),
      images.svgText,
    );
    check(
      "a PNG over the pixel budget is refused from its header",
      /over the display budget/.test(images.bomb ?? ""),
      images.bomb,
    );
    check(
      "every Blob URL is handed to the caller, and revoking it releases it",
      images.tracked === 1 && images.revoked,
      JSON.stringify(images),
    );
    check("nothing ran from the SVG", images.pwned === null, images.pwned);

    // xarray's collapsible sections work through the namespaced ids, styled by the shipped CSS.
    const xr = await page.evaluate(() => {
      const html =
        `<div><svg style="position: absolute; width: 0; height: 0"><defs><symbol id="icon-database" viewBox="0 0 32 32"><path d="M0 0h32v32H0z"/></symbol></defs></svg>` +
        `<pre class='xr-text-repr-fallback'>fallback</pre><div class='xr-wrap' style='display:none'><ul class='xr-sections'>` +
        `<li class='xr-section-item'><input id='section-1' class='xr-section-summary-in' type='checkbox'>` +
        `<label for='section-1' class='xr-section-summary'>Data variables:</label>` +
        `<div class='xr-section-details'><svg class='icon xr-icon-database'><use xlink:href='#icon-database'></use></svg>details</div></li></ul></div></div>`;
      const node = window.__display.renderHtml(html, { document, track: () => {} });
      document.body.append(node);
      const label = node.querySelector("label");
      const input = document.getElementById(label.getAttribute("for"));
      const details = node.querySelector(".xr-section-details");
      const hidden = getComputedStyle(details).display;
      label.click();
      const shown = getComputedStyle(details).display;
      const use = node.querySelector("use");
      return {
        fallbackHidden: getComputedStyle(node.querySelector(".xr-text-repr-fallback")).display,
        wrap: getComputedStyle(node.querySelector(".xr-wrap")).display,
        hidden,
        shown,
        checked: input.checked,
        sprite: node.querySelector("svg.fv-defs") !== null,
        use: use.getAttribute("xlink:href") ?? use.getAttribute("href"),
        symbol: node.querySelector("symbol").id,
      };
    });
    check(
      "xarray's text fallback is hidden and its HTML shown by the shipped CSS",
      xr.fallbackHidden === "none" && xr.wrap === "block",
      JSON.stringify(xr),
    );
    check(
      "…a section opens from its label",
      xr.hidden === "none" && xr.shown === "contents" && xr.checked,
      JSON.stringify(xr),
    );
    check(
      "…and its icons point at its own, namespaced sprite sheet",
      xr.sprite && xr.use === `#${xr.symbol}`,
      JSON.stringify(xr),
    );

    // An inline figure keeps its gradient and clip path through the id renaming.
    const figure = await page.evaluate(() => {
      const html =
        `<svg width="20" height="20"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient>` +
        `<clipPath id="c"><rect width="10" height="10"/></clipPath></defs>` +
        `<rect id="r" width="20" height="20" fill="url(#g)" clip-path="url(#c)"/></svg>`;
      const node = window.__display.renderHtml(html, { document, track: () => {} });
      document.body.append(node);
      const rect = node.querySelector("rect[id$='-r']");
      const style = getComputedStyle(rect);
      return {
        fill: style.fill,
        clip: style.clipPath,
        gradient: node.querySelector("linearGradient").id,
        clipPath: node.querySelector("clipPath").id,
      };
    });
    check(
      "an inline SVG's fill and clip-path follow the renamed gradient and clip path",
      figure.fill.includes(`#${figure.gradient}`) &&
        figure.clip.includes(`#${figure.clipPath}`) &&
        figure.gradient !== "g",
      JSON.stringify(figure),
    );

    check("no request left the page's origin", foreign.length === 0, foreign.join(", "));
  } finally {
    await server.close();
  }
  return checks;
});

process.exit(report("rich-output: the sanitiser and renderers in a real parser", result));
