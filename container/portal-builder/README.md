# The canonical builder image

`ghcr.io/freva-org/portal-builder:<version>` is the supported CI path, and the
only supported path for RST: it carries the exact Docutils and the exact helper
the rendering profile pins, and the browser that renders diagrams at build time.
It does not carry a compiled STAC Browser.

Consumers pin an **immutable digest**, not a tag:

```yaml
container:
  image: ghcr.io/freva-org/portal-builder@sha256:<digest>
```

## What is inside, and why

| Contents                                       | Reason                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| Node and the built `@freva-org/portal-builder` | The CLI and build engine                                                |
| `/opt/portal-rst` with pinned Docutils         | The RST helper's whole handshake must match, not merely its protocol    |
| `/opt/pw-browsers`                             | Mermaid renders at build time; nothing about diagrams ships to a reader |

What is deliberately **not** inside: the compiled STAC Browser. This is the generally published
base builder, and baking a third-party application into it would put it in the supply chain of
every deployment, including the majority that never enable the feature. The image carries the
recipe - the pin, the reviewed patch series, the preparation scripts and their verification - and
a deployment that enables the `stac-browser` component runs one network-enabled preparation stage
and passes the verified directory to the network-disabled build with `--stac-materials`. See
`packages/stac-browser/UPSTREAM.md`.

## Running a hermetic build

```console
docker run --rm --network=none \
  -v "$PWD:/src:ro" \
  -v "$PWD/build:/out" \
  ghcr.io/freva-org/portal-builder@sha256:<digest> \
  build --source-root /src --config /src/portal/portal.yaml --out /out/portal
```

`--network=none` is not a precaution to be relaxed when something breaks: a build
that needs the network is a defect in the image or the configuration, and CI is
required to run this form.

The source root is mounted read-only and the output is a separate volume, because
the builder refuses an output tree that overlaps any declared input.

## Recording the image in the artifact

An artifact identifies its builder by **resolved platform**, not only by the index
digest, because one index resolves to different images on `linux/amd64` and
`linux/arm64`. CI passes what it resolved:

```console
freva-portal-builder build ... \
  --builder-image '{"reference":"ghcr.io/freva-org/portal-builder:1.0.0",
                    "indexDigest":"sha256:...",
                    "manifestDigest":"sha256:...",
                    "configDigest":"sha256:...",
                    "platform":{"os":"linux","architecture":"amd64"}}'
```

## Rebuilding the image

Image preparation is allowed a network: it installs the Python helper and
downloads the browser. It does not fetch or compile upstream STAC Browser -
that is a separate stage a deployment runs only when it has enabled the
component. Changing any pin is an adapter-maintenance pull request with the
upgrade checks in FP-001 section 12.5, not a silent rebuild.

Build through the wrapper:

```console
container/portal-builder/build.sh 1.0.0
```

### Base images

The Dockerfile pins its Node base images by digest and takes them as build
arguments **with no default**, so `docker build` without them fails at the first
`FROM` rather than resolving a moving tag.

The digests live in `base-images.lock`, which is produced by

```console
container/portal-builder/resolve-base-digests.sh
```

That file is generated, never authored. A digest is an observation of a registry
at a point in time, so a hand-written one is at best unverified and at worst
fiction that reads as a guarantee. If `base-images.lock` is absent from a
checkout, the canonical image has not been pinned yet in that lineage and
`build.sh` refuses to run; resolve it on a machine with registry access, review
the two references, and commit them.

Both stages also install Debian packages from `snapshot.debian.org` at
`DEBIAN_SNAPSHOT`, so the apt layer is a function of that date and this file
rather than of when the build happened to run.
