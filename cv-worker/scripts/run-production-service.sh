#!/bin/bash

set -euo pipefail

readonly worker_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly repository_directory="$(cd "$worker_directory/.." && pwd -P)"
readonly environment_file="$repository_directory/.env.local"
readonly uv_path="${1:-}"

if [[ -z "$uv_path" || "$uv_path" != /* || ! -x "$uv_path" ]]; then
  echo "The LaunchAgent must provide an absolute executable uv path" >&2
  exit 1
fi

if [[ ! -r "$environment_file" ]]; then
  echo "Missing readable environment file: $environment_file" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$environment_file"
set +a

if [[ -z "${PREDICTION_CV_SECRET:-}" || "$PREDICTION_CV_SECRET" == "replace-with-a-dedicated-random-secret" ]]; then
  echo "PREDICTION_CV_SECRET must be configured in $environment_file" >&2
  exit 1
fi

readonly production_server_url="https://koth.company"
export KOTH_SERVER_URL="$production_server_url"
if [[ "$KOTH_SERVER_URL" != "https://koth.company" ]]; then
  echo "The production worker refuses to target $KOTH_SERVER_URL" >&2
  exit 1
fi

export PATH="$(dirname "$uv_path"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PYTHONUNBUFFERED=1
export UV_CACHE_DIR="$worker_directory/.uv-cache"

cd "$worker_directory"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) starting CV worker against $KOTH_SERVER_URL"
exec "$uv_path" run --frozen koth-cv run --takeover
