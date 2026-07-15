#!/usr/bin/env bash
set -Eeuo pipefail

KOTH_ROOT="${KOTH_ROOT:-/srv/koth-company}"
KOTH_CONFIG_DIR="${KOTH_CONFIG_DIR:-/etc/koth-company}"
COMPOSE_FILE="${KOTH_ROOT}/compose.yaml"
DEPLOY_ENV="${KOTH_ROOT}/deploy.env"
RELEASES_DIR="${KOTH_ROOT}/releases"
DEPLOYMENT_RELEASE_FILE="${KOTH_ROOT}/deployment-release"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_full_sha() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || die "release must be a lowercase 40-character Git SHA"
}

env_value() {
  local file="$1"
  local key="$2"
  local count

  count="$(grep -c "^${key}=" "$file" || true)"
  [[ "$count" == "1" ]] || die "$file must define $key exactly once"
  sed -n "s/^${key}=//p" "$file"
}

require_env_value() {
  local file="$1"
  local key="$2"
  local value

  value="$(env_value "$file" "$key")"
  [[ -n "$value" ]] || die "$key must not be empty in $file"
  case "$value" in
    *replace-with* | *password@host* | *your-domain* | *"..."*)
      die "$key still contains a placeholder in $file"
      ;;
  esac
  if LC_ALL=C grep -q '[^ -~]' <<<"$value"; then
    die "$key must contain printable ASCII only in $file"
  fi
  printf '%s' "$value"
}

require_secret() {
  local file="$1"
  local key="$2"
  local minimum="$3"
  local maximum="${4:-4096}"
  local value

  value="$(require_env_value "$file" "$key")"
  ((${#value} >= minimum && ${#value} <= maximum)) ||
    die "$key in $file must be between $minimum and $maximum characters"
}

require_database_url() {
  local file="$1"
  local key="$2"
  local value

  value="$(require_env_value "$file" "$key")"
  [[ "$value" =~ ^postgres(ql)?://[^[:space:]]+$ ]] ||
    die "$key in $file must be a PostgreSQL URL"
}

require_https_origin() {
  local file="$1"
  local key="$2"
  local value

  value="$(require_env_value "$file" "$key")"
  [[ "$value" =~ ^https://[A-Za-z0-9.-]+(:443)?$ ]] ||
    die "$key in $file must be an HTTPS origin without a path or trailing slash"
  [[ "$value" != "https://localhost" && "$value" != https://127.* ]] ||
    die "$key in $file must be publicly reachable"
}

validate_environment_files() {
  local deploy_file="$1"
  local web_file="$2"
  local api_file="$3"
  local migrate_file="$4"
  local token_file="$5"
  local key
  local value
  local better_auth_url
  local callback_url
  local registry
  local file

  for file in "$deploy_file" "$web_file" "$api_file" "$migrate_file"; do
    [[ -f "$file" ]] || die "missing $file"
  done
  [[ -s "$token_file" ]] || die "missing or empty tunnel token: $token_file"

  registry="$(require_env_value "$deploy_file" KOTH_REGISTRY)"
  [[ "$registry" =~ ^ghcr\.io/[a-z0-9._/-]+$ ]] ||
    die "KOTH_REGISTRY must be an uncredentialed ghcr.io repository prefix"
  require_https_origin "$deploy_file" KOTH_PUBLIC_ORIGIN

  require_database_url "$web_file" DATABASE_URI
  require_secret "$web_file" PAYLOAD_SECRET 32

  require_database_url "$api_file" PREDICTION_DATABASE_URI
  require_secret "$api_file" BETTER_AUTH_SECRET 32
  require_https_origin "$api_file" BETTER_AUTH_URL
  require_secret "$api_file" TWITCH_CLIENT_ID 8 128
  require_secret "$api_file" TWITCH_CLIENT_SECRET 16 256
  require_secret "$api_file" TWITCH_EVENTSUB_SECRET 10 100
  require_secret "$api_file" PREDICTION_INGEST_SECRET 32
  require_secret "$api_file" PREDICTION_CV_SECRET 32

  value="$(require_env_value "$api_file" PREDICTION_DATABASE_POOL_SIZE)"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || ((value < 1 || value > 20)); then
    die "PREDICTION_DATABASE_POOL_SIZE must be an integer from 1 through 20"
  fi
  value="$(require_env_value "$api_file" TWITCH_BROADCASTER_LOGIN)"
  [[ "$value" =~ ^[a-z0-9_]{4,25}$ ]] || die "TWITCH_BROADCASTER_LOGIN is invalid"
  for key in CHANNEL_POINTS_TO_CROWNS_RATE CHANNEL_POINTS_MAX_PER_USER_PER_EVENT; do
    value="$(require_env_value "$api_file" "$key")"
    if [[ ! "$value" =~ ^[0-9]+$ ]] || ((value <= 0)); then
      die "$key must be a positive integer"
    fi
  done
  value="$(require_env_value "$api_file" PREDICTION_MARKETS_ENABLED)"
  [[ "$value" == "true" || "$value" == "false" ]] ||
    die "PREDICTION_MARKETS_ENABLED must be exactly true or false"
  for key in REALTIME_MAX_SUBSCRIBERS REALTIME_MAX_CONNECTIONS_PER_IP REALTIME_MAX_LIFETIME_MS SHUTDOWN_GRACE_MS TWITCH_HTTP_TIMEOUT_MS; do
    value="$(require_env_value "$api_file" "$key")"
    if [[ ! "$value" =~ ^[0-9]+$ ]] || ((value <= 0)); then
      die "$key must be a positive integer"
    fi
  done
  (($(env_value "$api_file" REALTIME_MAX_SUBSCRIBERS) <= 100000)) ||
    die "REALTIME_MAX_SUBSCRIBERS must not exceed 100000"
  (($(env_value "$api_file" REALTIME_MAX_CONNECTIONS_PER_IP) <= 1000)) ||
    die "REALTIME_MAX_CONNECTIONS_PER_IP must not exceed 1000"
  value="$(env_value "$api_file" REALTIME_MAX_LIFETIME_MS)"
  ((value >= 60000 && value <= 3600000)) ||
    die "REALTIME_MAX_LIFETIME_MS must be from 60000 through 3600000"
  value="$(env_value "$api_file" SHUTDOWN_GRACE_MS)"
  ((value >= 1000 && value <= 60000)) || die "SHUTDOWN_GRACE_MS must be from 1000 through 60000"
  value="$(env_value "$api_file" TWITCH_HTTP_TIMEOUT_MS)"
  ((value <= 30000)) || die "TWITCH_HTTP_TIMEOUT_MS must not exceed 30000"

  better_auth_url="$(env_value "$api_file" BETTER_AUTH_URL)"
  callback_url="$(require_env_value "$api_file" TWITCH_EVENTSUB_CALLBACK_URL)"
  [[ "$callback_url" == "$better_auth_url/api/twitch/eventsub" ]] ||
    die "TWITCH_EVENTSUB_CALLBACK_URL must equal BETTER_AUTH_URL/api/twitch/eventsub"

  require_database_url "$migrate_file" DATABASE_URI
  require_secret "$migrate_file" PAYLOAD_SECRET 32
  require_database_url "$migrate_file" PREDICTION_DATABASE_URI
  [[ "$(env_value "$migrate_file" DATABASE_URI)" == "$(env_value "$web_file" DATABASE_URI)" ]] ||
    die "migrate.env DATABASE_URI must match web.env"
  [[ "$(env_value "$migrate_file" PAYLOAD_SECRET)" == "$(env_value "$web_file" PAYLOAD_SECRET)" ]] ||
    die "migrate.env PAYLOAD_SECRET must match web.env"
  [[ "$(env_value "$migrate_file" PREDICTION_DATABASE_URI)" == "$(env_value "$api_file" PREDICTION_DATABASE_URI)" ]] ||
    die "migrate.env PREDICTION_DATABASE_URI must match api.env"

  value="$(tr -d '\r\n' <"$token_file")"
  ((${#value} >= 32 && ${#value} <= 4096)) ||
    die "the Cloudflare tunnel token has an unexpected length"
  [[ "$(awk 'END { print NR }' "$token_file")" == "1" ]] ||
    die "the Cloudflare tunnel token must be a single line"
  if LC_ALL=C grep -q '[^!-~]' <<<"$value"; then
    die "the Cloudflare tunnel token must contain visible ASCII only"
  fi
  case "$value" in
    *replace-with* | *validation-only*) die "the Cloudflare tunnel token is a placeholder" ;;
  esac
}

require_not_world_accessible() {
  local file="$1"
  local mode

  mode="$(stat -c '%a' "$file")"
  ((10#${mode: -1} == 0)) || die "$file must not be accessible to other users"
}

require_layout() {
  require_command curl
  require_command docker
  require_command flock
  require_command timeout
  [[ -f "$COMPOSE_FILE" ]] || die "missing $COMPOSE_FILE"
  [[ -f "$DEPLOY_ENV" ]] || die "missing $DEPLOY_ENV"
  [[ -f "$DEPLOYMENT_RELEASE_FILE" ]] || die "missing $DEPLOYMENT_RELEASE_FILE"
  require_full_sha "$(tr -d '[:space:]' <"$DEPLOYMENT_RELEASE_FILE")"
  validate_environment_files \
    "$DEPLOY_ENV" \
    "$KOTH_CONFIG_DIR/web.env" \
    "$KOTH_CONFIG_DIR/api.env" \
    "$KOTH_CONFIG_DIR/migrate.env" \
    "$KOTH_CONFIG_DIR/cloudflare-tunnel.token"
  require_not_world_accessible "$DEPLOY_ENV"
  require_not_world_accessible "$DEPLOYMENT_RELEASE_FILE"
  require_not_world_accessible "$KOTH_CONFIG_DIR/web.env"
  require_not_world_accessible "$KOTH_CONFIG_DIR/api.env"
  require_not_world_accessible "$KOTH_CONFIG_DIR/migrate.env"
  require_not_world_accessible "$KOTH_CONFIG_DIR/cloudflare-tunnel.token"
  docker compose version >/dev/null
}

require_deployment_bundle() {
  local release="$1"
  local installed

  installed="$(tr -d '[:space:]' <"$DEPLOYMENT_RELEASE_FILE")"
  [[ "$installed" == "$release" ]] ||
    die "deployment files are from $installed, not requested release $release"
}

require_market_acceptance() {
  local acceptance="${1:-}"
  local api_file="${2:-$KOTH_CONFIG_DIR/api.env}"
  local configured

  configured="$(env_value "$api_file" PREDICTION_MARKETS_ENABLED)"
  case "$acceptance" in
    --markets-enabled) [[ "$configured" == "true" ]] || die "api.env has markets disabled" ;;
    --markets-disabled) [[ "$configured" == "false" ]] || die "api.env has markets enabled" ;;
    *) die "pass --markets-enabled or --markets-disabled to acknowledge the configured market state" ;;
  esac
}

acquire_lock() {
  mkdir -p "$RELEASES_DIR"
  exec 9>"$KOTH_ROOT/.deploy.lock"
  flock -n 9 || die "another deployment operation is running"
}

compose() {
  KOTH_CONFIG_DIR="$KOTH_CONFIG_DIR" docker compose \
    --project-directory "$KOTH_ROOT" \
    --env-file "$DEPLOY_ENV" \
    --file "$COMPOSE_FILE" \
    "$@"
}

compose_timed() {
  local duration="$1"
  shift
  KOTH_CONFIG_DIR="$KOTH_CONFIG_DIR" timeout --foreground --signal=TERM --kill-after=30s "$duration" \
    docker compose \
    --project-directory "$KOTH_ROOT" \
    --env-file "$DEPLOY_ENV" \
    --file "$COMPOSE_FILE" \
    "$@"
}

run_migrations() {
  local container_name="koth-company-migrate-${KOTH_RELEASE}"
  local exit_code

  docker rm --force "$container_name" >/dev/null 2>&1 || true
  set +e
  compose_timed 10m --profile tools run --name "$container_name" --rm --no-deps migrate
  exit_code=$?
  set -e

  if ((exit_code != 0)); then
    docker rm --force "$container_name" >/dev/null 2>&1 || true
    return "$exit_code"
  fi
  if docker container inspect "$container_name" >/dev/null 2>&1; then
    docker rm --force "$container_name" >/dev/null 2>&1 || true
    die "migration container remained after completion"
  fi
}

read_release() {
  local name="$1"
  local path="$RELEASES_DIR/$name"
  [[ -f "$path" ]] || return 1
  tr -d '[:space:]' <"$path"
}

write_release() {
  local name="$1"
  local release="$2"
  local destination="$RELEASES_DIR/$name"
  local temporary
  temporary="$(mktemp "$RELEASES_DIR/.${name}.XXXXXX")"
  printf '%s\n' "$release" >"$temporary"
  chmod 0640 "$temporary"
  mv -f "$temporary" "$destination"
}

ensure_disk_space() {
  local available_kib
  available_kib="$(df -Pk "$KOTH_ROOT" | awk 'NR == 2 { print $4 }')"
  [[ "$available_kib" =~ ^[0-9]+$ ]] || die "could not determine available disk space"
  ((available_kib >= 10 * 1024 * 1024)) || die "at least 10 GiB of free disk is required"
}

verify_external_origin() {
  local origin
  local path
  local headers
  local body
  local curl_exit

  origin="$(env_value "$DEPLOY_ENV" KOTH_PUBLIC_ORIGIN)"
  for path in /healthz /api/health/live /api/health/ready; do
    curl --fail --silent --show-error --max-time 30 --output /dev/null "$origin$path" ||
      die "external verification failed for $origin$path"
  done

  headers="$(mktemp)"
  body="$(mktemp)"
  set +e
  curl \
    --fail \
    --silent \
    --show-error \
    --no-buffer \
    --max-time 20 \
    --header 'Accept: text/event-stream' \
    --dump-header "$headers" \
    --output "$body" \
    "$origin/api/predictions/events"
  curl_exit=$?
  set -e
  if [[ "$curl_exit" != "0" && "$curl_exit" != "28" ]]; then
    rm -f "$headers" "$body"
    die "external SSE request failed with curl exit $curl_exit"
  fi
  if ! grep -qi '^content-type: text/event-stream' "$headers" ||
    ! grep -Eq '^event: (stream\.ready|public\.snapshot)' "$body"; then
    rm -f "$headers" "$body"
    die "external SSE stream did not return an initial event"
  fi
  rm -f "$headers" "$body"
}

verify_stack() {
  local running
  local service

  running="$(compose ps --status running --services)"
  for service in web api gateway cloudflared; do
    grep -qx "$service" <<<"$running" || die "$service is not running"
  done

  compose exec -T web node -e \
    'const r=await fetch("http://127.0.0.1:3000/healthz");if(!r.ok)throw new Error("web health: "+r.status)'
  compose exec -T api bun -e \
    'const r=await fetch("http://127.0.0.1:4000/api/health/ready");if(!r.ok)throw new Error("api readiness: "+r.status)'
  compose exec -T api bun -e \
    'const r=await fetch("http://gateway:8080/api/health/live");if(!r.ok)throw new Error("gateway route: "+r.status)'
  compose exec -T api bun -e \
    'const {createHmac,randomUUID}=await import("node:crypto");const challenge="koth-deploy-challenge";const body=JSON.stringify({challenge});const id=randomUUID();const timestamp=new Date().toISOString();const signature="sha256="+createHmac("sha256",process.env.TWITCH_EVENTSUB_SECRET).update(id+timestamp+body).digest("hex");const r=await fetch("http://gateway:8080/api/twitch/eventsub",{method:"POST",headers:{"content-type":"application/json","twitch-eventsub-message-id":id,"twitch-eventsub-message-timestamp":timestamp,"twitch-eventsub-message-signature":signature,"twitch-eventsub-message-type":"webhook_callback_verification"},body});const response=await r.text();if(!r.ok||response!==challenge)throw new Error("EventSub challenge: "+r.status+" "+response)'
  verify_external_origin
}

start_release() {
  local release="$1"
  export KOTH_RELEASE="$release"
  compose up --detach --remove-orphans --wait --wait-timeout 180
  verify_stack
}

ensure_release_images() {
  local release="$1"
  shift
  local registry
  local service

  registry="$(env_value "$DEPLOY_ENV" KOTH_REGISTRY)"
  export KOTH_RELEASE="$release"
  for service in "$@"; do
    if ! docker image inspect "${registry}-${service}:${release}" >/dev/null 2>&1; then
      printf 'rollback image is missing locally; pulling %s\n' "${registry}-${service}:${release}" >&2
      compose pull "$service"
    fi
  done
}

prune_release_images() {
  local current="$1"
  local previous="${2:-}"
  local registry
  local service
  local repository
  local tag

  registry="$(env_value "$DEPLOY_ENV" KOTH_REGISTRY)"
  for service in web api migrate; do
    repository="${registry}-${service}"
    while read -r tag; do
      [[ "$tag" =~ ^[0-9a-f]{40}$ ]] || continue
      if [[ "$tag" != "$current" && "$tag" != "$previous" ]]; then
        docker image rm "${repository}:${tag}" >/dev/null ||
          printf 'warning: could not remove old image %s:%s\n' "$repository" "$tag" >&2
      fi
    done < <(docker image ls "$repository" --format '{{.Tag}}')
  done
}
