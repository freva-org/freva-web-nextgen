#!/usr/bin/env bash
# Build the canonical portal-builder image from the recorded base-image digests.
#
#   container/portal-builder/build.sh <version>
#
# Fails, rather than falling back to a tag, when base-images.lock is absent. An
# image built on an unrecorded base is not the canonical image.
set -euo pipefail

version="${1:-}"
if [ -z "$version" ]; then
  echo "usage: container/portal-builder/build.sh <version>" >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
lock="$here/base-images.lock"
docker="${DOCKER:-docker}"

if [ ! -f "$lock" ]; then
  cat >&2 <<'MSG'
container/portal-builder/base-images.lock is missing.

The Dockerfile pins its base images by digest and takes those digests as build
arguments with no default, so there is nothing to fall back to. Run

  container/portal-builder/resolve-base-digests.sh

on a machine with registry access, review the result, and commit it.
MSG
  exit 1
fi

build_image=""
runtime_image=""
while IFS= read -r line; do
  case "$line" in
    '#'*|'') continue ;;
    PORTAL_BUILDER_NODE_BUILD_IMAGE=*) build_image="${line#*=}" ;;
    PORTAL_BUILDER_NODE_RUNTIME_IMAGE=*) runtime_image="${line#*=}" ;;
    *)
      echo "build.sh: unexpected line in base-images.lock: $line" >&2
      exit 1
      ;;
  esac
done < "$lock"

for pair in "PORTAL_BUILDER_NODE_BUILD_IMAGE:$build_image" \
            "PORTAL_BUILDER_NODE_RUNTIME_IMAGE:$runtime_image"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  case "$value" in
    *@sha256:????????????????????????????????????????????????????????????????) ;;
    *)
      echo "build.sh: $name is not a full sha256 digest reference: '$value'" >&2
      exit 1
      ;;
  esac
done

exec "$docker" build \
  -f "$here/Dockerfile" \
  -t "ghcr.io/freva-org/portal-builder:$version" \
  --build-arg "PORTAL_BUILDER_NODE_BUILD_IMAGE=$build_image" \
  --build-arg "PORTAL_BUILDER_NODE_RUNTIME_IMAGE=$runtime_image" \
  "$root"
