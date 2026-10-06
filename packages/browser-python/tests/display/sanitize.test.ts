/**
 * @vitest-environment jsdom
 */
// The DOM boundary for Python-authored markup. jsdom parses well enough to prove what the
// allowlist keeps and drops; `browser-tests/rich-output.mjs` proves the same against real parsers.
import { describe, expect, it } from "vitest";
import { sanitizeHtml, sanitizeSvg } from "../../src/display/sanitize.js";

const html = (markup: string): HTMLElement => {
  const div = document.createElement("div");
  div.append(sanitizeHtml(markup, document));
  return div;
};

describe("sanitizeHtml", () => {
  it("drops scripts, handlers, forms, frames, styles and style attributes", () => {
    const out = html(
      `<p onclick="x()" style="color:red">hi<script>alert(1)</script></p>` +
        `<style>p{}</style><link rel=stylesheet href="https://evil/x.css"><form><input name=a></form>` +
        `<iframe src="https://evil"></iframe><object data=x></object><embed src=x>` +
        `<meta http-equiv=refresh content="0;url=https://evil"><base href="https://evil/">` +
        `<button formaction="https://evil">b</button><textarea>t</textarea><select></select>`,
    );
    expect(
      out.querySelector(
        "script,style,link,form,iframe,object,embed,meta,base,button,textarea,select",
      ),
    ).toBeNull();
    expect(out.innerHTML).not.toMatch(/onclick|style=|evil/);
    expect(out.querySelector("p")?.textContent).toBe("hi");
  });

  it("keeps tables with pandas' classes and drops the scoped style block", () => {
    const out = html(
      `<div><style scoped>.dataframe tbody tr th { vertical-align: top; }</style>` +
        `<table border="1" class="dataframe"><thead><tr style="text-align: right;"><th></th><th>a</th></tr></thead>` +
        `<tbody><tr><th>0</th><td>1</td></tr></tbody></table><p>1 rows × 1 columns</p></div>`,
    );
    const table = out.querySelector("table.dataframe");
    expect(table).not.toBeNull();
    expect(out.querySelector("style")).toBeNull();
    expect(out.querySelector("tr")?.hasAttribute("style")).toBe(false);
    expect(out.querySelectorAll("td")).toHaveLength(1);
  });

  it("refuses every resource load: img src, srcset, svg image, use with an external href", () => {
    const out = html(
      `<img src="https://evil/x.png"><img src="x.png" srcset="https://evil/2x.png 2x">` +
        `<img src="data:image/png;base64,iVBORw0KGgo=">` +
        `<svg><image href="https://evil/i.png"/><use href="https://evil/s.svg#x"/>` +
        `<use xlink:href="data:image/svg+xml,x"/></svg>` +
        `<a href="javascript:alert(1)">j</a><a href="https://example.org/">ok</a>`,
    );
    const imgs = [...out.querySelectorAll("img")];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(out.querySelector("image")).toBeNull();
    for (const use of out.querySelectorAll("use")) {
      expect(use.getAttribute("href")).toBeNull();
      expect(use.getAttribute("xlink:href")).toBeNull();
    }
    const links = [...out.querySelectorAll("a")];
    expect(links[0]?.hasAttribute("href")).toBe(false);
    expect(links[1]?.getAttribute("target")).toBe("_blank");
    expect(links[1]?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("namespaces ids and follows label, href and use references; drops dangling ones", () => {
    const first = html(
      `<input id="s1" type="checkbox" class="xr-section-summary-in" checked>` +
        `<label for="s1">Coordinates</label><label for="nowhere">x</label>` +
        `<svg><defs><symbol id="icon-database"><path d="M0 0"/></symbol></defs></svg>` +
        `<svg class="icon"><use xlink:href="#icon-database"></use></svg><a href="#s1">jump</a>`,
    );
    const second = html(`<input id="s1" type="checkbox">`);
    const input = first.querySelector("input");
    const id = input?.getAttribute("id") ?? "";
    expect(id).toMatch(/^fv.+-s1$/);
    expect(id).not.toBe(second.querySelector("input")?.getAttribute("id"));
    const [label, dangling] = [...first.querySelectorAll("label")];
    expect(label?.getAttribute("for")).toBe(id);
    expect(dangling?.hasAttribute("for")).toBe(false);
    expect(first.querySelector("a")?.getAttribute("href")).toBe(`#${id}`);
    const symbol = first.querySelector("symbol")?.getAttribute("id");
    expect(first.querySelector("use")?.getAttribute("xlink:href")).toBe(`#${symbol}`);
    expect(first.querySelector("svg")?.classList.contains("fv-defs")).toBe(true);
    expect(first.querySelector("svg.icon")?.classList.contains("fv-defs")).toBe(false);
  });

  it("follows gradient, clip, mask and marker references into the namespace; drops the rest", () => {
    const out = html(
      `<svg><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient>` +
        `<clipPath id="c"><rect width="1" height="1"/></clipPath><mask id="m"><rect/></mask>` +
        `<marker id="k"><path d="M0 0"/></marker></defs>` +
        `<rect id="a" fill="url(#g)" stroke="url('#g') blue" clip-path="url(#c)" mask='url("#m")'` +
        ` marker-start="url(#k)" marker-end="url(#k)"/>` +
        `<rect id="b" fill="url(#gone) green" stroke="url(#gone)" clip-path="url(#gone)"` +
        ` mask="url(https://evil/m.svg#m)" marker-mid="url(#elsewhere)"/>` +
        `<rect id="plain" fill="red" stroke="none"/></svg>`,
    );
    const id = (selector: string) => out.querySelector(selector)?.getAttribute("id") ?? "";
    const [g, c, m, k] = ["linearGradient", "clipPath", "mask", "marker"].map(id);
    expect(g).toMatch(/^fv.+-g$/);
    // The first two rects draw the clip path and the mask.
    const [, , a, b, plain] = [...out.querySelectorAll("rect")];
    expect(a?.getAttribute("fill")).toBe(`url(#${g})`);
    expect(a?.getAttribute("stroke")).toBe(`url(#${g}) blue`);
    expect(a?.getAttribute("clip-path")).toBe(`url(#${c})`);
    expect(a?.getAttribute("mask")).toBe(`url(#${m})`);
    expect(a?.getAttribute("marker-start")).toBe(`url(#${k})`);
    expect(a?.getAttribute("marker-end")).toBe(`url(#${k})`);
    expect(b?.getAttribute("fill")).toBe("green");
    expect(b?.getAttribute("stroke")).toBe("none");
    for (const name of ["clip-path", "mask", "marker-mid"])
      expect(b?.hasAttribute(name)).toBe(false);
    expect([plain?.getAttribute("fill"), plain?.getAttribute("stroke")]).toEqual(["red", "none"]);
    expect(out.innerHTML).not.toMatch(/evil|url\(#(g|c|m|k|gone|elsewhere)\)/);
  });

  it("keeps only checkbox inputs", () => {
    const out = html(`<input type="text" value="x"><input type="checkbox" value="y" disabled>`);
    const inputs = [...out.querySelectorAll("input")];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.getAttribute("type")).toBe("checkbox");
    expect(inputs[0]?.hasAttribute("value")).toBe(false);
    expect(inputs[0]?.hasAttribute("disabled")).toBe(true);
  });
});

describe("sanitizeSvg", () => {
  it("keeps drawing and drops script, foreignObject, animation and external refs", () => {
    const out = sanitizeSvg(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="x()">` +
        `<script>alert(1)</script><foreignObject><div>x</div></foreignObject>` +
        `<animate attributeName="x" to="1"/><set attributeName="y" to="2"/>` +
        `<image href="https://evil/x.png"/><a href="https://evil">l</a>` +
        `<rect width="5" height="5" fill="red" style="fill:blue"/></svg>`,
      document,
    );
    expect(out).not.toBeNull();
    expect(out).toMatch(/<rect/);
    expect(out).not.toMatch(/script|foreignObject|animate|<set|<image|evil|onload|style=/i);
  });

  it("refuses something that is not an SVG", () => {
    expect(sanitizeSvg("<p>not svg</p>", document)).toBeNull();
  });
});
