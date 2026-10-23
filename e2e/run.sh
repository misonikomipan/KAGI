#!/usr/bin/env bash
# Start a throwaway Pocket ID, run the end-to-end suite against it, then tear it down.
# Requires Docker and `bunx playwright install chromium` once.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose -f e2e/compose.yml up -d --wait 2>/dev/null || docker compose -f e2e/compose.yml up -d
trap 'docker compose -f e2e/compose.yml down -v >/dev/null 2>&1' EXIT

for _ in $(seq 1 60); do
  curl -sf http://localhost:1411/.well-known/openid-configuration >/dev/null && break
  sleep 1
done

bun test ./e2e/kagi.e2e.ts --timeout 60000
