#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
OLD_RELEASE=1111111111111111111111111111111111111111
NEW_RELEASE=2222222222222222222222222222222222222222

mkdir -p "$TEMP_DIR/bin"
cat >"$TEMP_DIR/bin/flock" <<'EOF'
#!/usr/bin/env bash
[[ "${FAKE_FLOCK_FAIL:-false}" != "true" ]]
EOF
chmod 0700 "$TEMP_DIR/bin/flock"
export PATH="$TEMP_DIR/bin:$PATH"

make_fixture() {
  local name="$1"
  local root="$TEMP_DIR/$name/root"
  local config="$TEMP_DIR/$name/config"
  local bundle="$TEMP_DIR/$name/bundle"
  mkdir -p "$root/ops" "$root/releases" "$config" "$bundle/deploy/ops"

  printf 'old compose\n' >"$root/compose.yaml"
  printf 'old caddy\n' >"$root/Caddyfile"
  printf '%s\n' "$OLD_RELEASE" >"$root/deployment-release"
  printf '%s\n' "$OLD_RELEASE" >"$root/releases/current"
  chmod 0600 "$root/compose.yaml" "$root/deployment-release"
  chmod 0644 "$root/Caddyfile"
  for operation in common.sh deploy install-release rollback status; do
    printf '#!/usr/bin/env bash\n# old %s\nexit 0\n' "$operation" >"$root/ops/$operation"
    chmod 0700 "$root/ops/$operation"
  done

  printf '%s\n' "$NEW_RELEASE" >"$bundle/RELEASE"
  printf 'new compose\n' >"$bundle/deploy/compose.yaml"
  printf 'new caddy\n' >"$bundle/deploy/Caddyfile"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$bundle/deploy/ops/common.sh"
  cat >"$bundle/deploy/ops/deploy" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"$KOTH_ROOT/deploy-call"
if [[ "${TEST_DEPLOY_FAIL:-false}" == "true" ]]; then
  exit 23
fi
printf '%s\n' "$1" >"$KOTH_ROOT/releases/current"
EOF
  cp "$ROOT/deploy/ops/install-release" "$bundle/deploy/ops/install-release"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$bundle/deploy/ops/rollback"
  cat >"$bundle/deploy/ops/status" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'healthy\n' >"$KOTH_ROOT/status-call"
EOF
  chmod 0700 "$bundle/deploy/ops/"*
}

make_fixture success
rm "$TEMP_DIR/success/root/ops/install-release"
KOTH_ROOT="$TEMP_DIR/success/root" KOTH_CONFIG_DIR="$TEMP_DIR/success/config" \
  bash "$ROOT/deploy/ops/install-release" \
  "$TEMP_DIR/success/bundle" "$NEW_RELEASE" --markets-disabled
[[ "$(cat "$TEMP_DIR/success/root/compose.yaml")" == "new compose" ]]
[[ "$(cat "$TEMP_DIR/success/root/Caddyfile")" == "new caddy" ]]
[[ "$(cat "$TEMP_DIR/success/root/deployment-release")" == "$NEW_RELEASE" ]]
[[ "$(cat "$TEMP_DIR/success/root/releases/current")" == "$NEW_RELEASE" ]]
[[ "$(cat "$TEMP_DIR/success/root/deploy-call")" == "$NEW_RELEASE --markets-disabled" ]]
[[ "$(cat "$TEMP_DIR/success/root/status-call")" == "healthy" ]]
[[ -x "$TEMP_DIR/success/root/ops/install-release" ]]

make_fixture failure
rm "$TEMP_DIR/failure/root/ops/install-release"
if TEST_DEPLOY_FAIL=true \
  KOTH_ROOT="$TEMP_DIR/failure/root" KOTH_CONFIG_DIR="$TEMP_DIR/failure/config" \
  bash "$ROOT/deploy/ops/install-release" \
  "$TEMP_DIR/failure/bundle" "$NEW_RELEASE" --markets-disabled; then
  printf 'a failed deployment must fail the release installation\n' >&2
  exit 1
else
  exit_code=$?
fi
[[ "$exit_code" == "23" ]]
[[ "$(cat "$TEMP_DIR/failure/root/compose.yaml")" == "old compose" ]]
[[ "$(cat "$TEMP_DIR/failure/root/Caddyfile")" == "old caddy" ]]
[[ "$(cat "$TEMP_DIR/failure/root/deployment-release")" == "$OLD_RELEASE" ]]
[[ "$(head -1 "$TEMP_DIR/failure/root/ops/deploy")" == "#!/usr/bin/env bash" ]]
[[ ! -e "$TEMP_DIR/failure/root/ops/install-release" ]]
grep -q 'old deploy' "$TEMP_DIR/failure/root/ops/deploy"

make_fixture locked
if FAKE_FLOCK_FAIL=true \
  KOTH_ROOT="$TEMP_DIR/locked/root" KOTH_CONFIG_DIR="$TEMP_DIR/locked/config" \
  bash "$ROOT/deploy/ops/install-release" \
  "$TEMP_DIR/locked/bundle" "$NEW_RELEASE" --markets-disabled >/dev/null 2>&1; then
  printf 'a concurrent deployment lock must reject release installation\n' >&2
  exit 1
fi
[[ "$(cat "$TEMP_DIR/locked/root/compose.yaml")" == "old compose" ]]
[[ "$(cat "$TEMP_DIR/locked/root/deployment-release")" == "$OLD_RELEASE" ]]

printf 'release installation is atomic and rollback-safe\n'
