# syntax=docker/dockerfile:1
#
# code-server-omp-docker
# =======================
# code-server + oh-my-pi (omp) in a single image.
# Three-tier tooling: baked-in core, managed mounted tools, custom user tools.
#
# Build:
#   docker build \
#     --build-context toolchain=code-server-omp-docker \
#     -t code-server-omp:latest \
#     code-server
#
# (where "code-server" is the upstream coder/code-server checkout)

# ── Stage: oh-my-pi builder ─────────────────────────────────────────
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS omp-builder
WORKDIR /app
# Install oh-my-pi globally via bun
RUN bun install -g @oh-my-pi/pi-coding-agent@15.2.4

# ── Stage: toolchain (builder repo artifacts) ───────────────────────
# This stage only exists so --build-context toolchain=... can inject
# the managed-tools scripts and config without copying the builder
# repo into the upstream source tree.
FROM scratch AS toolchain
COPY package.json package-lock.json go.mod go.sum tools.go /opt/code-server-omp/managed-tools/
COPY managed-tools/ /opt/code-server-omp/managed-tools/managed-tools/
COPY scripts/ /opt/code-server-omp/managed-tools/scripts/
COPY scripts/code-server-entrypoint.sh /usr/local/bin/code-server-omp-entrypoint

# ── Stage: code-server build ────────────────────────────────────────
FROM debian:13-slim@sha256:d2ec0a1766c01dad04a185c2d5558b0adace167a7f1758ce80f0017698431d06 AS code-server-builder

# We copy code-server from the official release .deb rather than building
# from source. This stage pins the exact version and architecture.
ARG CODE_SERVER_VERSION=4.99.3
ARG TARGETARCH=amd64

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_${TARGETARCH}.deb" \
    -o /tmp/code-server.deb

# ── Stage: Docker-in-Docker ────────────────────────────────────────
FROM docker:29.5.2-dind@sha256:6b9cd914eb9c6b342c040a49a27a5eb3804453bae6ecc90f7ff96133595a95e8 AS docker-dind

# ── Stage: runtime ──────────────────────────────────────────────────
FROM debian:13-slim@sha256:d2ec0a1766c01dad04a185c2d5558b0adace167a7f1758ce80f0017698431d06 AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# ── System packages (baked core) ────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    dumb-init \
    dnsutils \
    file \
    git \
    git-lfs \
    htop \
    iproute2 \
    jq \
    less \
    locales \
    lsb-release \
    lsof \
    man-db \
    nano \
    netcat-openbsd \
    openssh-client \
    procps \
    psmisc \
    python3 \
    python3-pip \
    python3-venv \
    rsync \
    sudo \
    tar \
    unzip \
    wget \
    xz-utils \
    zsh \
  && ln -sf /usr/bin/python3 /usr/local/bin/python \
  && git lfs install \
  && rm -rf /var/lib/apt/lists/*

# ── Locale ──────────────────────────────────────────────────────────
RUN sed -i "s/# en_US.UTF-8/en_US.UTF-8/" /etc/locale.gen \
  && locale-gen
ENV LANG=en_US.UTF-8

# ── code-server installation ────────────────────────────────────────
COPY --from=code-server-builder /tmp/code-server.deb /tmp/code-server.deb
RUN dpkg -i /tmp/code-server.deb && rm /tmp/code-server.deb

# ── oh-my-pi installation (baked) ───────────────────────────────────
COPY --from=omp-builder /usr/local/bin/omp /usr/local/bin/omp
COPY --from=omp-builder /root/.bun /root/.bun

# ── Node.js + npm (baked from official image) ───────────────────────
# Pin to same version as Bun's Node for compatibility
RUN curl -fsSL https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.xz \
    | tar -C /usr/local --strip-components=1 -xJf -

# ── User setup ──────────────────────────────────────────────────────
RUN adduser --gecos '' --disabled-password --uid 1000 coder \
  && echo "coder ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/nopasswd \
  && chmod 0440 /etc/sudoers.d/nopasswd

# ── fixuid for host UID mapping ─────────────────────────────────────
RUN ARCH="$(dpkg --print-architecture)" \
  && curl -fsSL "https://github.com/boxboat/fixuid/releases/download/v0.6.0/fixuid-0.6.0-linux-$ARCH.tar.gz" \
     | tar -C /usr/local/bin -xzf - \
  && chown root:root /usr/local/bin/fixuid \
  && chmod 4755 /usr/local/bin/fixuid \
  && mkdir -p /etc/fixuid \
  && printf "user: coder\ngroup: coder\n" > /etc/fixuid/config.yml

# ── Toolchain scripts & config ──────────────────────────────────────
COPY --from=toolchain /opt/code-server-omp /opt/code-server-omp
COPY --from=toolchain /usr/local/bin/code-server-omp-entrypoint /usr/local/bin/code-server-omp-entrypoint

# ── Docker-in-Docker binaries ─────────────────────────────────────
COPY --from=docker-dind /usr/local/bin/ /usr/local/bin/
COPY --from=docker-dind /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

# ── Runtime directories & config ────────────────────────────────────
ENV HOME=/home/coder
ENV NODE_ENV=production
ENV DOCKER_TLS_CERTDIR=
ENV NPM_CONFIG_PREFIX=/home/coder/.npm-global
ENV MANAGED_NPM_PREFIX=/home/coder/.npm-global
ENV BUN_INSTALL=/home/coder/.bun
ENV CARGO_HOME=/home/coder/.cargo
ENV MANAGED_CARGO_HOME=/home/coder/.cargo
ENV GOPATH=/home/coder/.go
ENV GOBIN=/home/coder/.go/bin
ENV MANAGED_GO_ROOT=/home/coder/.local/go
ENV PYTHONUSERBASE=/home/coder/.local/pip
ENV MANAGED_RELEASE_BIN_DIR=/home/coder/.local/bin
ENV RUSTUP_HOME=/home/coder/.rustup
ENV MANAGED_RUSTUP_HOME=/home/coder/.rustup
ENV XDG_CACHE_HOME=/home/coder/.cache
ENV XDG_CONFIG_HOME=/home/coder/.config
ENV XDG_DATA_HOME=/home/coder/.local/share
ENV XDG_STATE_HOME=/home/coder/.local/state
ENV CODE_SERVER_OMP_CONFIG_CACHE_DIR=/home/coder/.local/state/code-server-omp/config
ENV CODE_SERVER_OMP_TMPDIR=/home/coder/.local/state/code-server-omp/tmp
ENV ENTRYPOINTD=/home/coder/entrypoint.d

ENV PATH=/home/coder/.local/bin:/home/coder/.npm-global/bin:/home/coder/.local/go/bin:/home/coder/.go/bin:/home/coder/.cargo/bin:/home/coder/.local/pip/bin:/home/coder/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN mkdir -p \
    /home/coder/.bun \
    /home/coder/.cache \
    /home/coder/.cargo/bin \
    /home/coder/.config \
    /home/coder/.go/bin \
    /home/coder/.local/bin \
    /home/coder/.local/go/bin \
    /home/coder/.local/pip/bin \
    /home/coder/.local/share \
    /home/coder/.local/state/code-server-omp \
    /home/coder/.local/state \
    /home/coder/.npm-global \
    /home/coder/.ssh \
    /home/coder/workspaces \
    /home/coder/entrypoint.d \
  && chown -R coder:coder /home/coder \
  && npm config set prefix /home/coder/.npm-global

# ── Entrypoint.d scripts (run on container start) ───────────────────
# Users can mount scripts here to customize workspace initialization.
# https://github.com/coder/code-server/issues/5177

EXPOSE 8080

USER coder
WORKDIR /home/coder

ENTRYPOINT ["/usr/local/bin/code-server-omp-entrypoint"]
