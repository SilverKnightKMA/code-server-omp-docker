# Baked Tools Monitoring

## Overview

This document describes how the baked-in tools of the code-server-omp Docker
image are monitored for updates, and what must happen when a baked tool needs
an upgrade.

## Baked Tools vs User-Mounted Tools

### Baked Tools

Baked tools are installed in the Docker image at build time. They are available
to every container created from the image, regardless of bind-mounts or volumes.

Examples: code-server, node, bun, omp, docker, gosu, git, curl, jq, python3.

Baked tools **cannot be updated without rebuilding and re-publishing the image**.
A container restart alone will still have the old version.

### User-Mounted (Managed) Tools

User-mounted tools are installed by the managed-tools framework into persistent
volumes mounted at `/home/coder`. Examples: pyright, eslint, gh, actionlint,
hadolint, Go toolchain.

User-mounted tools update on container restart via the managed-tools init
script. They do **not** require an image rebuild. Only the managed-tools config
or the install scripts need updating.

## Monitor Types

Every baked tool in `managed-tools/baked-tools.json` has a `monitorType` field
that falls into one of three categories.

### 1. `dependabot`

The tool version is pinned in a Dockerfile `FROM` image reference that
Dependabot's docker ecosystem can detect. Dependabot only monitors `FROM`
image tags — it **cannot** detect version pins set via `ARG`, `RUN curl`,
or `RUN bun install` inside the Dockerfile.

| Tool | Dependabot Ecosystem | Pinned In |
|------|---------------------|-----------|
| bun | docker (Dockerfile) | `Dockerfile.dockerfile` (`FROM oven/bun:1.3.14`) |
| docker | docker (Dockerfile) | `Dockerfile.dockerfile` (`FROM docker:29.5.2-dind`) |
| dockerd | docker (Dockerfile) | `Dockerfile.dockerfile` (`FROM docker:29.5.2-dind`) |

Dependabot opens a PR when a newer version of the base image tag is available.
That PR triggers `baked-tools-check.yml` which rebuilds the image and validates
it. After merge to main, the build-image workflow publishes the new image.

### 2. `baked-tools-monitor`

For tools that are version-pinned using `ARG`, `RUN curl`, `RUN bun install`,
or any other Dockerfile mechanism that is **not** a `FROM` image reference.
Dependabot cannot detect these pins, so this workflow checks upstream versions
directly and reports drift.

| Tool | Pinning Mechanism | Upstream Source |
|------|-------------------|-----------------|
| code-server | `ARG CODE_SERVER_VERSION=4.99.3` in Dockerfile | GitHub releases (coder/code-server) |
| node | `curl nodejs.org/dist/v24.16.0/...` in Dockerfile | Node.js LTS line (nodejs.org) |
| omp | `bun install -g @oh-my-pi/pi-coding-agent@15.2.4` in Dockerfile | npm registry |

When `baked-tools-monitor` finds an update is available, it reports it in the
workflow summary. Automatic PR creation for these tools can be added later.
For now, any version bump must be done manually in `Dockerfile.dockerfile`,
which triggers `baked-tools-check.yml` to validate the new image.

### 3. `intentionally-unpinned`


These tools come from the Debian stable apt repository and are *not* version-
pinned in the Dockerfile. Debian's security team backports CVE patches to the
stable release, so the version stays within the same Debian release cycle but
receives security updates through `docker pull` (which fetches the rebuilt
debian:13-slim base image with updated packages).

| Tool | Source | Rationale |
|------|--------|-----------|
| gosu | debian:13-slim (apt) | Minimal tool, no breaking changes |
| dumb-init | debian:13-slim (apt) | Minimal init wrapper, no version churn |
| git | debian:13-slim (apt) | Debian security backports patches |
| curl | debian:13-slim (apt) | Debian security backports patches |
| jq | debian:13-slim (apt) | Debian security backports patches |
| python3 | debian:13-slim (apt) | Tied to Debian release cycle |
| pip | debian:13-slim (apt) | Bundled with python3-pip package |

The base image (`debian:13-slim` with a pinned digest) is monitored by
Dependabot (docker ecosystem). When Dependabot updates the digest, the
rebuilt image picks up any apt-package updates from the new base.

## Update Policies

### Image Rebuild Required

**Any change to a baked tool requires a full image rebuild.** This includes:

- Pinning a new version in `Dockerfile.dockerfile`
- Changing an apt package list
- Changing install scripts in `scripts/`
- Changing `managed-tools/baked-tools.json`

The `baked-tools-check.yml` workflow validates the image on every PR and push
that touches any of:

- `Dockerfile*`
- `scripts/code-server-entrypoint.sh`
- `managed-tools/baked-tools.json`
- `bootstrap.sh`
- `package.json` / `package-lock.json` (affects baked npm/omp tools)
- `.github/workflows/baked-tools-check.yml`

### Managed-Tools Updates (No Image Rebuild)

Changes to `managed-tools/manifest.json`, `scripts/managed-*-tools.mjs`, or
other managed-tools configuration do **not** require an image rebuild — unless
they modify the baked fallback (the baked copy in the image).

## Workflows

### `baked-tools-check.yml`

Triggers: PR/push touching baked tool paths → build image, verify commands,
check versions, validate coder shell PATH, entrypoint regression.

### `baked-tools-monitor.yml`

Triggers: weekly schedule, PR/push touching `managed-tools/baked-tools.json`
or `Dockerfile.dockerfile`.

Validates that every baked tool has a valid `monitorType`, checks Dependabot
ecosystem mapping, checks upstream versions for non-Dependabot tools (if any
are configured with `baked-tools-monitor` type), and produces a structured
summary table.

### `build-image.yml`

Triggers: push to main (any path). Builds and pushes the `:latest` image to
GHCR. Ensures that all merged baked-tool updates are published.

## Adding a New Baked Tool
1. Install it in `Dockerfile.dockerfile`.
2. Add its version check to `baked-tools-check.yml` (commands + version steps,
   plus coder shell step if user-facing).
3. Add an entry in `managed-tools/baked-tools.json` with:
   - `name`, `currentVersion`, `versionCommand`, `installedPath`
   - `sourceType`
   - `monitorType` — one of `dependabot`, `baked-tools-monitor`,
     `intentionally-unpinned`
   - `updateImpact`: `rebuild-image-required` (always for baked tools)
4. Select the correct `monitorType`:
   - **`dependabot`**: only if the version is pinned via a Dockerfile `FROM`
     image tag that Dependabot docker can detect (e.g., `FROM oven/bun:1.3.14`).
   - **`baked-tools-monitor`**: for any version pin set via `ARG`, `RUN curl`,
     `RUN apt-get install <specific-version>`, `RUN bun install -g pkg@version`,
     or any other Dockerfile mechanism that is **not** a `FROM` reference.
   - **`intentionally-unpinned`**: for tools inherited from the Debian base
     image via apt without a version pin, with a written rationale.
5. If using `dependabot`, verify the `sourceType` in baked-tools.json is
   `base-image` (not `github-release`, `script`, `npm`, `apt`, or any type that
   indicates the version comes from a non-FROM source). The validation workflow
   enforces this.
6. If using `baked-tools-monitor`, add the upstream version check to
   `.github/workflows/baked-tools-monitor.yml` in the `Check upstream versions`
   step.
7. If `intentionally-unpinned`, provide a rationale string in
   `intentionalRationale`.

## Baked Tool Change Gate

Any change that affects a baked tool's version, installation method, or
definition must pass the following validation before merging to `main`.

### Required checks per change type

| Change touches | Must pass |
|----------------|-----------|
| `Dockerfile*`, `scripts/**`, `bootstrap.sh` | `baked-tools-check` + `baked-tools-monitor` |
| `managed-tools/baked-tools.json` | `baked-tools-check` + `baked-tools-monitor` |
| `package.json`, `package-lock.json`, `bun.lock` | `baked-tools-check` |
| `managed-tools/manifest.json`, `managed-tools/policy.json` | `managed-tools-check` |
| `scripts/managed-*-tools.mjs` (user-mounted tool scripts) | `managed-tools-check` |
| `.github/workflows/baked-tools-check.yml` | `baked-tools-check` |
| `.github/workflows/baked-tools-monitor.yml` | `baked-tools-check` + `baked-tools-monitor` |

### What each workflow validates

**`baked-tools-check`** — Builds the Docker image from scratch and validates
that all baked commands exist, return expected versions, and work inside the
coder shell (the real runtime terminal user). This is the primary gate for
image integrity.

**`baked-tools-monitor`** — Reads `managed-tools/baked-tools.json` and
validates every tool has a correct `monitorType`, Dependabot ecosystem
mapping is accurate, no unresolved template variables exist, and upstream
version checks report drift for `baked-tools-monitor`-type tools.

**`managed-tools-check`** — Validates user-mounted tool manifests without
building a Docker image. Does not replace `baked-tools-check`.

### What is not required here

Image publishing to GHCR and automated version bump PRs are separate
concerns implemented by `build-image.yml` and Dependabot. This validation
gate only ensures that if a baked-tool change merges, the image builds
correctly and all baked tools work.
