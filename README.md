# code-server-omp-docker

code-server (VS Code trong browser) + oh-my-pi (omp coding agent) trong một Docker image, với kiến trúc 3-tier tool.

## Yêu cầu

- Docker Engine + Docker Compose (hoặc Docker Desktop)
- ~4GB RAM cho container, ~2GB disk cho image

## Quick start

```bash
# Clone repo
git clone https://github.com/SilverKnightKMA/code-server-omp-docker.git
cd code-server-omp-docker

# Tạo data directories
mkdir -p data/workspaces \
  data/ssh data/config/git data/config/gh \
  data/npm-global data/bun data/local-bin data/local-go \
  data/local-pip data/cargo data/rustup data/go \
  data/code-server-omp-cache

# Build image
docker compose build

# Start container
docker compose up -d

# Mở http://localhost:8080
```

## Sau khi container chạy

### Bước 1: Kiểm tra container

```bash
docker compose logs -f          # Xem log
docker compose ps               # Kiểm tra trạng thái
```

### Bước 2: Vào container

```bash
docker compose exec -it code-server-omp bash
```

### Bước 3: Cài managed tools (tùy chọn)

```bash
# Trong container:
cd /opt/code-server-omp/managed-tools

# Xem trạng thái
npm run managed-tools:status

# Cài npm tools (TypeScript LSP, ESLint, Prettier, ...)
npm run managed-tools:npm:init

# Cài Go toolchain + gopls + shfmt
npm run managed-tools:go:init

# Cài release binaries (gh, yq, ripgrep, actionlint, hadolint)
npm run managed-tools:mounted:init

# Cài tất cả
npm run managed-tools:init
```

### Bước 4: Auth GitHub CLI

```bash
# Trong container:
gh auth login
```

### Bước 5: Config SSH + Git

```bash
# Trên host (trước khi start container):
# Copy SSH keys vào mounted volume
cp -r ~/.ssh/* ./data/ssh/
chmod 600 ./data/ssh/*

# Copy git config
cp ~/.gitconfig ./data/config/git/config
```

## Tính năng nâng cao

### Docker-in-Docker

Uncomment trong `docker-compose.yml`:
```yaml
environment:
  ENABLE_DIND: "true"
privileged: true
volumes:
  - ./data/docker:/var/lib/docker
  - ./data/containerd:/var/lib/containerd
```

### Auto-install managed tools khi start

```yaml
environment:
  CODE_SERVER_OMP_AUTOINSTALL: "true"
```

### Entrypoint.d scripts

Mount scripts vào `/home/coder/entrypoint.d/` — chúng sẽ chạy mỗi khi container start.

## Kiến trúc 3-tier

| Tier | Ví dụ | Persist |
|------|-------|---------|
| **1. Baked-in** | code-server, omp, Node.js, Bun, Python, Git, Docker CLI | Trong image |
| **2. Managed mounted** | TypeScript LSP, Go, Rust, gh, yq, ripgrep | Volume data/ |
| **3. Custom mounted** | npm install -g, go install, cargo install | Volume data/ |

## Ports

- `8080`: code-server web UI

## Backup omp config

Sao lưu `~/.omp/` (auth keys, model config) — xem `omp-backup/restore.sh` trong repo local (không push lên GitHub).
