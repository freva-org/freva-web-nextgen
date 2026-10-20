# Cosmos scene assets

The scene's pre-generated **sky artwork**, in `sky/`. That is the whole set: a star sphere, a moon
and a sun, plus the manifest that records what they were drawn for.

## What used to be here, and why it is not

This folder held twelve rendered WebP **object bodies** — satellites, aircraft, a research vessel,
a radiosonde train, a surface buoy — that the renderer placed by name from a registry called `SPR`,
each with measured anchor and attachment points. The scene drew them moving: satellites crossed the
sky, the sonde climbed, the vessel and the buoy rode a swell.

The scene is static now, and the subjects that only existed to move were removed with the motion.
The satellites were the last two bodies standing, so when they went the registry went with them and
no code names a body any more. The files are deleted rather than kept unused: an artifact that
carries bytes nothing can ask for is an artifact whose contents no longer describe its behaviour,
and the same argument applies to the package. They remain in the repository's history, and in the
`cosmos-candidate-r3` source archive, if a later round wants them back.

The renderer's `sceneBodies()` still exists and returns `[]`. The packager asks every renderer the
same question, and a renderer that answers "none" is a different thing from one that cannot be
asked.

## How the sky art was made

`scripts/export-cosmos-art.mjs` runs `client/components/cosmos/art/sky-art.mjs` in a headless
browser, once, and commits the result. The drawings are the renderer's own: the star field and the
galactic band that used to be painted into an 1800 px canvas on every mount and every theme change,
and the moon and sun that were drawn with gradients and arcs.

Exporting them was a performance change, not an artistic one. The pictures are the same pictures;
what changed is that the browser decodes a file instead of running seventeen hundred star draws,
twenty-six hundred band points and a scintillation pass every time a reader flips the theme.

Re-run it only when `art/sky-art.mjs` changes:

```
node scripts/export-cosmos-art.mjs --browser /path/to/chromium
```

## What is in `sky/`

| file              | intrinsic | drawn for                                                                                                      |
| ----------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `sky-sphere.webp` | 1800×1800 | the star field and the galactic band, laid out at the texture's own size and scaled by the element's transform |
| `moon.webp`       | 394×394   | the night sky's luminary                                                                                       |
| `sun.webp`        | 555×555   | the day sky's luminary                                                                                         |
| `MANIFEST.json`   | —         | the geometry the art was exported for, and every file's intrinsic size, megapixels and encoding                |

`MANIFEST.json` is what makes "pre-generated" auditable rather than a claim, and
`tests/artifact/cosmos-theme.test.ts` reads the sphere's intrinsic side out of it and compares it
with the `SPHERE_TEXTURE` constant the renderer lays the element out at, so the two cannot drift.

## Publishing

`src/model/cosmos-scene.ts` copies this folder into the artifact under `_cosmos/<digest>/`, where
the digest covers every file's name and content together. A changed file moves one URL and nothing
is ever served stale. Nothing is copied at all unless the resolved theme asked for the Cosmos
backdrop.

Everything else the scene draws — the terrain, the contours, the ranges, the ocean section, the
iceberg and the ice station — is solved or baked in `scene.js` from closed expressions, and is not
a file.
