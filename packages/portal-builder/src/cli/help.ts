/** A literal dollar sign, so the shell example below is not a template hole. */
const DOLLAR = "$";

export const HELP = `freva-portal-builder - build-time portal framework (FP-001 v1)

Usage:
  freva-portal-builder validate   --source-root <dir> --config <portal.yaml> [--effective-at <RFC3339>]
  freva-portal-builder build      --source-root <dir> --config <portal.yaml> --out <dir> [--effective-at <RFC3339>]
                                  [--stac-materials <dir>]
  freva-portal-builder dev        [--source-root <dir>] --config <portal.yaml> [--port 4321]
  freva-portal-builder preview    --dir <artifact> [--port 4321]
  freva-portal-builder verify     --dir <artifact>
  freva-portal-builder archive    --dir <artifact> [--out <file>] [--compress]
  freva-portal-builder host-check --dir <artifact> --url https://portal.example.org/
  freva-portal-builder smoke      --stage <dir> --config <staged-relative> --out <dir>
                                  [--copy <src>=<dest>]... [--result <file>] [--keep]
  freva-portal-builder migrate    --from <ui-manifest.json> --out <dir>
  freva-portal-builder stac-plan  --source-root <dir> --config <portal.yaml> [--diagnostics json]
  freva-portal-builder prepare-playground --source-root <dir> --config <portal.yaml> --out <dir> [--force] [--dry-run]

Options:
  --source-root <dir>     The trusted source root. Required for validate and build.
  --config <file>         The portal.yaml to build, contained by the source root.
  --out <dir>             Output directory. Must be outside every declared input root.
  --effective-at <time>   RFC 3339 instant used to select dated announcements.
  --stac-materials <dir>  Prepared STAC Browser materials, produced beforehand by
                          'npm run prepare -w @freva-org/stac-browser'. Required
                          only when the portal enables the stac-browser
                          component; ignored when it does not. This build never
                          fetches, patches or compiles upstream, and it does not
                          look for materials it was not given.
                          FREVA_PORTAL_STAC_MATERIALS says the same thing.
  --python-materials <dir>  Prepared Python playground materials - the Freva
                          wheels and the curated add-ons' pinned artefacts -
                          produced beforehand by 'prepare-playground'. Required
                          only when the portal's playground needs files this
                          deployment must serve; ignored when it does not. The
                          files are copied into the artifact BEFORE its manifests
                          and checksums are computed, so they are covered by
                          'verify' like everything else. Adding them afterwards
                          is what makes an artifact unverifiable.
                          FREVA_PORTAL_PYTHON_MATERIALS says the same thing.
  --force                 For 'prepare-playground': fetch again even when the
                          cache is current and verifies.
  --dry-run               For 'prepare-playground': list what would be prepared
                          and touch neither the network nor the disk.
  --stage <dir>           Disposable staging root for 'smoke'. Must be empty.
  --copy <src>=<dest>     Copy an external tree into the stage. Repeatable.
  --result <file>         Where 'smoke' writes its JSON result.
  --keep                  Keep the staging root after 'smoke' finishes.
  --diagnostics json      Emit machine-readable diagnostics on stdout.
  --quiet                 Suppress the compiler's own progress output.

Preparing the Python playground:
  The playground needs static files a deployment serves itself: the Freva client
  wheels, for the freva-client profile, and each curated add-on's pinned
  artefacts. They are digest-checked by the interpreter at start, so they cannot
  be fetched from a CDN that does not have them and they cannot be invented.

  One command, with the network, reads the portal's own configuration and
  prepares exactly what that configuration needs:

    freva-portal-builder prepare-playground --source-root . --config portal/portal.yaml \
      --out .python-materials

  and the build is handed the result:

    freva-portal-builder build --source-root . --config portal/portal.yaml \
      --out build/portal --python-materials .python-materials

  Keep the cache OUTSIDE the artifact directory. It is validated by hashing its
  bytes against the pins, not by looking for a manifest, so a stale directory is
  prepared again rather than served.

  'validate' and 'build' never open a socket. 'prepare-playground' is the only
  command in this CLI that does.

There is no --runtime, no --api-settings and no silent HTTP fallback: the site's
routes, navigation, theme and content are decided here, not in a browser.

'stac-plan' answers one question for a deployment routine: does this
configuration need the preparation stage? It reads the closed 'stac-browser'
component's own 'enabled' field - there is no second feature flag - and
validates the rest of the configuration while it is there, so a "no" is about
a portal that would actually build.

STAC Browser:
  Freva owns one central recipe for building Radiant Earth's STAC Browser -
  the pin, the patch series, the toolchain and the verification - in
  packages/stac-browser. A deployment decides only whether to enable the
  closed 'stac-browser' component and which STAC API it points at.
  Preparation is a separate, network-enabled stage that runs only for a
  deployment that has enabled it; this build is network-disabled and consumes
  its verified output. Neither the published packages nor the base builder
  image contains the compiled third-party application.

Reproducibility:
  SOURCE_DATE_EPOCH   Seconds since the Unix epoch, as an integer. Required by
                      'build'; 'validate' does not emit an artifact and does
                      not need one. Derive it from the commit:
                        SOURCE_DATE_EPOCH="${DOLLAR}(git show -s --format=%ct HEAD)"

'smoke' builds an external consumer's own sources without putting them in this
repository. It copies each --copy source into the disposable --stage by value,
refusing symlinks, then runs validate, build and verify against that root and
writes a JSON result. It exits nonzero unless every step succeeded and nothing
was refused during staging. See docs/external-consumer-playground.md.

'archive' writes the canonical release archive - normalized order, fixed modes
and ownership, timestamps from SOURCE_DATE_EPOCH - and prints its SHA-256. That
digest is the release artifact identity.
`;
