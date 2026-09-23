# The canonical portal-builder image.
#
# Everything that needs a network lives in the `prepare` stage: npm installs, the
# STAC Browser checkout and compile, the Python helper, the browser used to render
# diagrams. The final stage contains those results and nothing that can fetch,
# which is what makes a consumer build hermetic rather than merely well behaved.
#
# Build (always through the wrapper, never `docker build` by hand):
#   container/portal-builder/build.sh 1.0.0
#
# The wrapper supplies the base-image digests from
# `container/portal-builder/base-images.lock`. The Dockerfile declares those as
# build arguments with no default, so a hand-run `docker build` without them
# fails immediately instead of silently resolving a moving tag.
#
# Use (source read-only, output on its own volume):
#   docker run --rm --network=none \
#     -v "$PWD:/src:ro" -v "$PWD/build:/out" \
#     ghcr.io/freva-org/portal-builder@sha256:<digest> \
#     build --source-root /src --config /src/portal/portal.yaml --out /out/portal

# --------------------------------------------------------------------------
# Stage 1: prepare. The only stage with a network.
# --------------------------------------------------------------------------
# The base is pinned by digest, not by tag: a tag is a moving target, and an
# image that can change under a pinned builder version defeats the point of
# pinning the builder version.
#
# The digests are NOT written here. A digest is an observation of a registry at a
# point in time; it cannot be authored, only resolved and recorded. They live in
# `base-images.lock`, which `resolve-base-digests.sh` produces from a registry
# and `build.sh` feeds in. These ARGs deliberately have no default: an empty
# expansion makes `FROM` invalid and the build stops.
ARG PORTAL_BUILDER_NODE_BUILD_IMAGE
ARG PORTAL_BUILDER_NODE_RUNTIME_IMAGE

FROM ${PORTAL_BUILDER_NODE_BUILD_IMAGE} AS prepare

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# Exact package versions, so a rebuild of this Dockerfile installs what the
# previous one did. `--no-install-recommends` keeps the set closed, and the
# snapshot repository keeps the versions resolvable after the mirror rolls.
ARG DEBIAN_SNAPSHOT=20260801T000000Z
RUN printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/%s bookworm main\n' "$DEBIAN_SNAPSHOT" \
      > /etc/apt/sources.list \
 && printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" \
      >> /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends \
      git=1:2.39.5-0+deb12u2 \
      python3=3.11.2-1+b1 \
      python3-venv=3.11.2-1+b1 \
      python3-pip=23.0.1+dfsg-1 \
      ca-certificates=20230311 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY package.json package-lock.json ./
COPY packages ./packages
COPY tools ./tools

# Exact, frozen installs. `npm ci` fails rather than rewriting a mismatched
# lockfile, which is the property that makes the image's dependency tree the one
# the repository declares.
RUN npm ci

# The pinned RST helper, with its exact Docutils and an exact build backend.
# `setuptools>=68` in pyproject.toml is a floor, not a pin, so the toolchain is
# fixed here and the build runs with no network of its own.
RUN python3 -m venv /opt/portal-rst \
 && /opt/portal-rst/bin/pip install --no-cache-dir --upgrade \
      "pip==25.2" "setuptools==80.9.0" "wheel==0.45.1" \
 && /opt/portal-rst/bin/pip install --no-cache-dir --no-build-isolation \
      ./tools/portal-rst-renderer

# The browser the build-time diagram renderer uses, installed by the Playwright
# the lockfile resolved. `npx --yes playwright@x` would be a second, unpinned
# fetch path that can disagree with the workspace.
RUN npm exec -w @freva-org/portal-builder -- playwright install --with-deps chromium

# Upstream STAC Browser is deliberately NOT built here.
#
# This image is the generally published base builder. Baking the compiled
# third-party application into it would put it into every Freva deployment's
# supply chain, including the great majority that never enable the feature - and
# would make the image the place a stale STAC could come from.
#
# What the image carries instead is the recipe: the pin, the reviewed patch
# series, the preparation scripts and the verification. A deployment that
# enables the `stac-browser` component runs one network-enabled stage
#
#   npm run stac:prepare -- --out <dir>
#
# and hands the verified directory to the network-disabled build
#
#   freva-portal-builder build --config <portal.yaml> --stac-materials <dir>
#
# See packages/stac-browser/UPSTREAM.md.

RUN npm run build -w @freva-org/freva-client-terminal \
 && npm run build -w @freva-org/databrowser \
 && npm run build -w @freva-org/ts-oidc-auth-client \
 && npm run build -w @freva-org/portal-builder

# --------------------------------------------------------------------------
# Stage 2: the shipped image.
# --------------------------------------------------------------------------
FROM ${PORTAL_BUILDER_NODE_RUNTIME_IMAGE} AS runtime

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    FREVA_PORTAL_RST=/opt/portal-rst/bin/freva-portal-rst \
    PATH=/opt/portal-rst/bin:/opt/freva-portal-builder/node_modules/.bin:$PATH \
    NODE_ENV=production

# Same snapshot as the prepare stage, for the same reason: a live mirror makes
# the runtime layer a function of the build date rather than of this file.
ARG DEBIAN_SNAPSHOT=20260801T000000Z
RUN printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/%s bookworm main\n' "$DEBIAN_SNAPSHOT" \
      > /etc/apt/sources.list \
 && printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" \
      >> /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends \
      python3 ca-certificates \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

COPY --from=prepare /opt/pw-browsers /opt/pw-browsers
COPY --from=prepare /opt/portal-rst /opt/portal-rst
COPY --from=prepare /build /opt/freva-portal-builder/workspace

# One executable on PATH, with a name that cannot shadow the legacy runtime CLI.
RUN ln -s /opt/freva-portal-builder/workspace/packages/portal-builder/bin/freva-portal-builder.mjs \
      /usr/local/bin/freva-portal-builder \
 && chmod +x /usr/local/bin/freva-portal-builder

# A non-root user, and a source root that is expected to be mounted read-only.
RUN useradd --create-home --uid 10001 builder \
 && mkdir -p /src /out \
 && chown builder:builder /out
USER builder
WORKDIR /out

LABEL org.opencontainers.image.title="freva portal-builder" \
      org.opencontainers.image.description="FP-001 build-time portal framework: closed YAML in, one immutable static artifact out." \
      org.opencontainers.image.source="https://github.com/freva-org/freva-web-nextgen" \
      org.opencontainers.image.licenses="BSD-3-Clause"

ENTRYPOINT ["freva-portal-builder"]
CMD ["help"]
