/**
 * Regenerate tests/src-manifest.json - the pin that makes any change under src/
 * fail a test.
 *
 * The manifest is not a security control; it is a review control. src/ carries
 * the security-critical code, and an unnoticed edit there is exactly what the
 * mutation gate cannot catch (it only proves the controls it knows about are
 * load-bearing). Refreshing this file is therefore a deliberate act: run it in
 * the same commit as the src/ change, so the diff shows both.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

const MANIFEST = "tests/src-manifest.json";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir).sort()) {
    const rel = `${dir}/${name}`;
    if (statSync(rel).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
};
const sha = (rel) => createHash("sha256").update(readFileSync(rel)).digest("hex");

const paths = walk("src");
const files = Object.fromEntries(paths.map((p) => [p, sha(p)]));
const treeSha256 = createHash("sha256")
  .update(paths.map((p) => `${p} ${sha(p)}`).join("\n"))
  .digest("hex");

writeFileSync(
  MANIFEST,
  JSON.stringify(
    {
      note: "sha256 of every file under src/. Refresh with `npm run manifest:refresh` in the same commit as any intentional src/ change.",
      generatedFrom: `@freva-org/ts-oidc-auth-client@${version}`,
      fileCount: paths.length,
      treeSha256,
      files,
    },
    null,
    2,
  ) + "\n",
);

console.log(`${MANIFEST}: ${paths.length} files, tree ${treeSha256.slice(0, 12)}…`);
