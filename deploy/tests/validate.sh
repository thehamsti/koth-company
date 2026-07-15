#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

for script in "$ROOT"/deploy/ops/common.sh "$ROOT"/deploy/ops/deploy "$ROOT"/deploy/ops/rollback "$ROOT"/deploy/ops/status; do
  bash -n "$script"
done

# shellcheck source=deploy/ops/common.sh
source "$ROOT/deploy/ops/common.sh"
require_full_sha 0000000000000000000000000000000000000000
if (require_full_sha not-a-sha >/dev/null 2>&1); then
  printf 'invalid release identifiers must be rejected\n' >&2
  exit 1
fi

printf '0000000000000000000000000000000000000000\n' >"$TEMP_DIR/deployment-release"
(
  DEPLOYMENT_RELEASE_FILE="$TEMP_DIR/deployment-release"
  require_deployment_bundle 0000000000000000000000000000000000000000
)
if (
  DEPLOYMENT_RELEASE_FILE="$TEMP_DIR/deployment-release"
  require_deployment_bundle 1111111111111111111111111111111111111111 >/dev/null 2>&1
); then
  printf 'deployment bundle must match the requested release\n' >&2
  exit 1
fi

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$ROOT"/deploy/ops/common.sh "$ROOT"/deploy/ops/deploy "$ROOT"/deploy/ops/rollback "$ROOT"/deploy/ops/status
fi

if grep -Eq '^[[:space:]]+ports:' "$ROOT/deploy/compose.yaml"; then
  printf 'compose file must not publish host ports\n' >&2
  exit 1
fi

if [[ "$(grep -c 'flush_interval -1' "$ROOT/deploy/Caddyfile")" != "1" ]]; then
  printf 'only SSE routes may disable Caddy response buffering\n' >&2
  exit 1
fi

if ! grep -q 'cloudflared.*tunnel.*ready\|"cloudflared", "tunnel"' "$ROOT/deploy/compose.yaml"; then
  printf 'cloudflared must have a readiness healthcheck\n' >&2
  exit 1
fi

if [[ "$(sed -n '/^  gateway:/,/^  web:/p' "$ROOT/deploy/compose.yaml" | grep -c 'NET_BIND_SERVICE')" != "1" ]]; then
  printf 'the pinned Caddy binary must retain its sole file capability\n' >&2
  exit 1
fi

if grep -Eq 'keep the apex pointed at Vercel|keep the Vercel project|restore the prior Vercel apex' "$ROOT/deploy/README.md"; then
  printf 'deployment guidance must not depend on the deleted Vercel project\n' >&2
  exit 1
fi

if ! grep -Fq '"cms:migrate": "bun scripts/migrate.ts"' "$ROOT/apps/web/package.json" ||
  ! grep -Fq 'payload.db.migrate({ migrations: payloadMigrations })' "$ROOT/apps/web/scripts/migrate.ts" ||
  ! grep -Fq 'bun /app/apps/web/scripts/migrate.ts' "$ROOT/docker/migrate-all"; then
  printf 'local Payload migrations must use the generated static migration list\n' >&2
  exit 1
fi

if ! grep -Fq 'max: 5' "$ROOT/apps/web/payload.config.ts" ||
  ! grep -Fq 'max: 2' "$ROOT/apps/web/scripts/migrate.config.ts"; then
  printf 'Payload pools must leave a client available beyond the reconnect monitor\n' >&2
  exit 1
fi

if ! grep -Fq 'batch -1 marker before deploying' "$ROOT/apps/web/scripts/migrate.ts"; then
  printf 'non-interactive migrations must reject unreconciled development schema changes\n' >&2
  exit 1
fi

if ! grep -Fq 'compose_timed 10m --profile tools run --name "$container_name" --rm --no-deps migrate' "$ROOT/deploy/ops/common.sh" ||
  ! grep -Fq 'run_migrations' "$ROOT/deploy/ops/deploy"; then
  printf 'production migrations must have a bounded runtime and deterministic cleanup\n' >&2
  exit 1
fi

if ! MIGRATIONS_DIR="$ROOT/apps/web/src/migrations" bun -e '
  import { readdir } from "node:fs/promises";
  const directory = process.env.MIGRATIONS_DIR;
  const expected = (await readdir(directory))
    .filter((file) => /^\d.*\.ts$/.test(file))
    .map((file) => file.slice(0, -3))
    .sort();
  const { migrations } = await import(`${directory}/index.ts`);
  const actual = migrations.map((migration) => migration.name);
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    process.exit(1);
  }
'; then
  printf 'generated Payload migration index must include every migration once and in order\n' >&2
  exit 1
fi

if ! grep -Fq 'const connectionString = process.env.PREDICTION_DATABASE_URI;' "$ROOT/docker/migrate-predictions.ts"; then
  printf 'prediction migrations must fail closed without their explicit database URI\n' >&2
  exit 1
fi

cleanup_log="$TEMP_DIR/migration-cleanup.log"
if (
  KOTH_RELEASE=0000000000000000000000000000000000000000
  compose_timed() { return 124; }
  docker() {
    printf '%s\n' "$*" >>"$cleanup_log"
    return 0
  }
  run_migrations
); then
  printf 'timed-out migrations must fail deployment\n' >&2
  exit 1
fi
if [[ "$(grep -Fc 'rm --force koth-company-migrate-0000000000000000000000000000000000000000' "$cleanup_log")" -lt 2 ]]; then
  printf 'timed-out migration containers must be removed before the lock is released\n' >&2
  exit 1
fi

if [[ "$(env_value "$ROOT/deploy/env/deploy.env.example" KOTH_PUBLIC_ORIGIN)" != "https://koth.company" ]]; then
  printf 'the shipped production verification origin must use the apex\n' >&2
  exit 1
fi

sed -n '/^  cloudflared:/,/^  gateway:/p' "$ROOT/deploy/compose.yaml" >"$TEMP_DIR/cloudflared-compose.yaml"
for argument in '--token-file' '/run/secrets/cloudflare_tunnel_token' '--url' 'http://gateway:8080'; do
  if ! grep -Fqx -- "      - $argument" "$TEMP_DIR/cloudflared-compose.yaml"; then
    printf 'cloudflared must use its token file and explicit gateway origin: missing %s\n' "$argument" >&2
    exit 1
  fi
done

if grep -q 'compose pull web api' "$ROOT/deploy/ops/rollback"; then
  printf 'rollback must not pull retained images unconditionally\n' >&2
  exit 1
fi

if grep -Eq 'TWITCH|BETTER_AUTH|PREDICTION_(CV|INGEST)' "$ROOT/deploy/env/migrate.env.example"; then
  printf 'migration environment must not receive runtime integration secrets\n' >&2
  exit 1
fi

start_line="$(grep -n 'start_release' "$ROOT/deploy/ops/deploy" | tail -1 | cut -d: -f1)"
record_line="$(grep -n 'write_release current' "$ROOT/deploy/ops/deploy" | cut -d: -f1)"
if [[ -z "$start_line" || -z "$record_line" || "$start_line" -ge "$record_line" ]] ||
  ! grep -q 'verify_external_origin' "$ROOT/deploy/ops/common.sh"; then
  printf 'external verification must pass before recording a release\n' >&2
  exit 1
fi

if grep -Eq 'uses: [^ ]+@v[0-9]' "$ROOT/.github/workflows/release-images.yml"; then
  printf 'release workflow actions must use immutable commit pins\n' >&2
  exit 1
fi

cp "$ROOT/deploy/env/web.env.example" "$TEMP_DIR/web.env"
cp "$ROOT/deploy/env/api.env.example" "$TEMP_DIR/api.env"
cp "$ROOT/deploy/env/migrate.env.example" "$TEMP_DIR/migrate.env"
printf 'validation-only-token\n' >"$TEMP_DIR/cloudflare-tunnel.token"

export KOTH_CONFIG_DIR="$TEMP_DIR"
export KOTH_RELEASE=0000000000000000000000000000000000000000
docker compose \
  --project-directory "$ROOT/deploy" \
  --env-file "$ROOT/deploy/env/deploy.env.example" \
  --file "$ROOT/deploy/compose.yaml" \
  --profile tools \
  config --quiet

cat >"$TEMP_DIR/valid-deploy.env" <<'EOF'
KOTH_REGISTRY=ghcr.io/thehamsti/koth-company
KOTH_PUBLIC_ORIGIN=https://origin.koth.company
EOF
cat >"$TEMP_DIR/valid-web.env" <<'EOF'
DATABASE_URI=postgresql://payload:secret@db.example/database?sslmode=verify-full
PAYLOAD_SECRET=payload-secret-value-with-at-least-32-characters
EOF
cat >"$TEMP_DIR/valid-api.env" <<'EOF'
PREDICTION_DATABASE_URI=postgresql://prediction:secret@db.example/database?sslmode=verify-full
PREDICTION_DATABASE_POOL_SIZE=5
BETTER_AUTH_SECRET=better-auth-secret-value-with-at-least-32-characters
BETTER_AUTH_URL=https://koth.company
TWITCH_CLIENT_ID=twitchclientid
TWITCH_CLIENT_SECRET=twitch-client-secret-value
TWITCH_BROADCASTER_LOGIN=hydramist
TWITCH_EVENTSUB_SECRET=eventsub-secret-value
TWITCH_EVENTSUB_CALLBACK_URL=https://koth.company/api/twitch/eventsub
TWITCH_HTTP_TIMEOUT_MS=10000
CHANNEL_POINTS_TO_CROWNS_RATE=1000
CHANNEL_POINTS_MAX_PER_USER_PER_EVENT=10000
PREDICTION_INGEST_SECRET=ingestion-secret-value-with-at-least-32-characters
PREDICTION_CV_SECRET=cv-secret-value-with-at-least-32-characters
PREDICTION_MARKETS_ENABLED=false
REALTIME_MAX_SUBSCRIBERS=5000
REALTIME_MAX_CONNECTIONS_PER_IP=20
REALTIME_MAX_LIFETIME_MS=300000
SHUTDOWN_GRACE_MS=10000
EOF
cat >"$TEMP_DIR/valid-migrate.env" <<'EOF'
DATABASE_URI=postgresql://payload:secret@db.example/database?sslmode=verify-full
PAYLOAD_SECRET=payload-secret-value-with-at-least-32-characters
PREDICTION_DATABASE_URI=postgresql://prediction:secret@db.example/database?sslmode=verify-full
EOF
printf 'cloudflare-tunnel-token-value-with-at-least-32-characters\n' >"$TEMP_DIR/valid-token"

validate_environment_files \
  "$TEMP_DIR/valid-deploy.env" \
  "$TEMP_DIR/valid-web.env" \
  "$TEMP_DIR/valid-api.env" \
  "$TEMP_DIR/valid-migrate.env" \
  "$TEMP_DIR/valid-token"
require_market_acceptance --markets-disabled "$TEMP_DIR/valid-api.env"
if (require_market_acceptance --markets-enabled "$TEMP_DIR/valid-api.env" >/dev/null 2>&1); then
  printf 'market-state acknowledgement must match api.env\n' >&2
  exit 1
fi
if (
  validate_environment_files \
    "$ROOT/deploy/env/deploy.env.example" \
    "$ROOT/deploy/env/web.env.example" \
    "$ROOT/deploy/env/api.env.example" \
    "$ROOT/deploy/env/migrate.env.example" \
    "$TEMP_DIR/valid-token" >/dev/null 2>&1
); then
  printf 'placeholder service configuration must be rejected\n' >&2
  exit 1
fi

if [[ "${1:-}" != "--static" ]]; then
  docker run --rm \
    --volume "$ROOT/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
    caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 \
    caddy validate --config /etc/caddy/Caddyfile
fi

printf 'deployment artifacts are valid\n'
