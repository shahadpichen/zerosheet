#!/usr/bin/env bash

# Executable Milestone 14 release checklist.
#
# A local toolchain test alone can hide broken plain-Node exports, stale SQL,
# malformed production profiles, or a spreadsheet bundle that accidentally
# became eager. This verifier exercises source tests, real PostgreSQL, compiled
# deploy artifacts, policy models, examples, production images, and runtime
# hardening as one repeatable acceptance boundary. It changes only idempotent
# development schema state, local Docker build cache, and disposable mktemp
# directories.
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_directory/../.." && pwd)"
temporary_directory="$(mktemp -d)"
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT INT TERM

cd "$repository_root"

node --version | grep -Eq '^v24\.'
pnpm --version | grep -Eq '^10\.'
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build

# Real PostgreSQL verifies migrations 006/007, sharing persistence, the
# aggregate SECURITY DEFINER audit function, and a clean drift result.
pnpm infra:db:migrate
ZEROSHEET_RUN_DB_INTEGRATION=true pnpm --filter @zerosheet/api exec vitest run \
  src/encryption/postgres-workbook-security-repository.integration.test.ts
node --env-file=.env apps/worker/dist/sharing-drift-audit.js

# Docker Compose must render every long-running and one-shot profile without
# interpolating credential values. Secret contents remain referenced by file.
docker compose \
  --env-file infra/production/environment.example \
  --file infra/production/compose.yaml \
  --profile bootstrap \
  --profile operations \
  config --quiet
if rg -n '^[[:space:]]+(KC_DB_PASSWORD|KC_BOOTSTRAP_ADMIN_PASSWORD|KEYCLOAK_BFF_CLIENT_SECRET|OPENFGA_AUTHN_PRESHARED_KEYS|ZEROSHEET_DB_PASSWORD):' infra/production/compose.yaml; then
  echo "A direct production secret variable replaced a mounted *_FILE boundary." >&2
  exit 1
fi

# File-backed Compose secrets keep their host ownership instead of adopting a
# service's UID. Verify the generator's root-directory/read-only-file contract,
# then prove the final non-root API image can read an explicitly mounted file
# without revealing its contents in this verifier's output.
secret_directory="$temporary_directory/secrets"
bash infra/scripts/generate-production-secrets.sh "$secret_directory"
portable_mode() {
  local path="$1"
  if stat -f '%Lp' "$path" >/dev/null 2>&1; then
    stat -f '%Lp' "$path"
  else
    stat -c '%a' "$path"
  fi
}
test "$(portable_mode "$secret_directory")" = '700'
while IFS= read -r -d '' secret_file; do
  test "$(portable_mode "$secret_file")" = '444'
done < <(find "$secret_directory" -type f -print0)

# pnpm's deploy output runs under plain Node, not tsx/Vitest. Rewriting and
# importing both applications catches workspace source exports before images
# are built or pushed.
api_deploy="$temporary_directory/api"
worker_deploy="$temporary_directory/worker"
pnpm --filter @zerosheet/api deploy --prod --legacy "$api_deploy"
node infra/scripts/prepare-deployed-workspace-packages.mjs "$api_deploy"
node -e "await import('$api_deploy/node_modules/@zerosheet/contracts/dist/index.js'); await import('$api_deploy/dist/app.js')"
pnpm --filter @zerosheet/worker deploy --prod --legacy "$worker_deploy"
node infra/scripts/prepare-deployed-workspace-packages.mjs "$worker_deploy"
node -e "await import('$worker_deploy/dist/sharing-drift-repository.js')"

node infra/scripts/verify-web-bundle-budget.mjs apps/web/dist

# Local TypeScript artifacts can hide missing workspace build ordering, while
# macOS cannot exercise Linux image users and executable metadata. Building all
# production profiles from their Dockerfiles closes that release gap. The
# Caddy validation uses the same sole capability granted in Compose because its
# executable carries the matching file capability even for validation mode.
docker compose \
  --env-file infra/production/environment.example \
  --file infra/production/compose.yaml \
  --profile bootstrap \
  --profile operations \
  build --quiet
test "$(docker image inspect zerosheet-production-api --format '{{.Config.User}}')" = 'node'
test "$(docker image inspect zerosheet-production-sharing-drift-audit --format '{{.Config.User}}')" = 'node'
test "$(docker image inspect zerosheet-production-keycloak --format '{{.Config.User}}')" = '1000'
test "$(docker image inspect zerosheet-production-openfga --format '{{.Config.User}}')" = '65532:65532'
test "$(docker image inspect zerosheet-production-caddy --format '{{.Config.User}}')" = 'nobody:nobody'
docker run --rm --read-only --cap-drop ALL \
  --volume "$secret_directory/zerosheet_db_password:/run/secrets/zerosheet_db_password:ro" \
  zerosheet-production-api \
  node -e "const fs=require('node:fs'); if (!fs.readFileSync('/run/secrets/zerosheet_db_password','utf8').trim()) process.exit(1)"
docker run --rm --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --env ZEROSHEET_DOMAIN=sheets.example.com \
  --env ZEROSHEET_IDENTITY_DOMAIN=identity.example.com \
  --env ZEROSHEET_ACME_EMAIL=operator@example.com \
  --entrypoint caddy \
  zerosheet-production-caddy \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile

git diff --check

echo "Milestone 14 developer SDK and release verification passed."
