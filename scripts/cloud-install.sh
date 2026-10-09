#!/usr/bin/env bash
set -euo pipefail
export XDG_DATA_HOME=/workspace/.cache/data
export XDG_CACHE_HOME=/workspace/.cache
export PNPM_HOME=/workspace/.cache/pnpm
export npm_config_cache=/workspace/.cache/npm
cd /workspace/AgentConnect
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("AgentConnect requires Node 24")'
pnpm install --frozen-lockfile
pnpm local:init
docker compose up -d --wait
pnpm db:migrate
pnpm storage:init
pnpm build
