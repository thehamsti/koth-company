#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

RUNNER_ROOT="$TEMP_DIR/runner"
CRONTAB_STATE="$TEMP_DIR/crontab"
NOHUP_LOG="$TEMP_DIR/nohup.log"
FLOCK_LOG="$TEMP_DIR/flock.log"
export CRONTAB_STATE NOHUP_LOG FLOCK_LOG RUNNER_ROOT

mkdir -p "$TEMP_DIR/bin" "$RUNNER_ROOT/bin"
touch "$RUNNER_ROOT/.runner"
printf '#!/usr/bin/env bash\nexit 0\n' >"$RUNNER_ROOT/bin/runsvc.sh"
chmod 0700 "$RUNNER_ROOT/bin/runsvc.sh"

cat >"$TEMP_DIR/bin/crontab" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-l" ]]; then
  if [[ -n "${CRONTAB_LIST_ERROR:-}" ]]; then
    printf '%s\n' "$CRONTAB_LIST_ERROR" >&2
    exit 2
  fi
  [[ -f "$CRONTAB_STATE" ]] || exit 1
  cat "$CRONTAB_STATE"
  exit 0
fi
cp "$1" "$CRONTAB_STATE"
EOF
cat >"$TEMP_DIR/bin/nohup" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$NOHUP_LOG"
EOF
cat >"$TEMP_DIR/bin/flock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FLOCK_LOG"
EOF
chmod 0700 "$TEMP_DIR/bin/"*
export PATH="$TEMP_DIR/bin:$PATH"

wait_for_line_count() {
  local file="$1"
  local expected="$2"
  local attempts=0
  while [[ ! -f "$file" || "$(wc -l <"$file" | tr -d '[:space:]')" != "$expected" ]]; do
    ((attempts += 1))
    [[ "$attempts" -lt 100 ]] || return 1
    sleep 0.01
  done
}

cat >"$CRONTAB_STATE" <<'EOF'
*/5 * * * * ~/duckdns/duck.sh >/dev/null 2>&1
# BEGIN koth-production-runner
* * * * * /obsolete/runner >/dev/null 2>&1
# END koth-production-runner
EOF

bash "$ROOT/deploy/runner/activate" "$ROOT/deploy/runner/run"
wait_for_line_count "$NOHUP_LOG" 1

launcher="$RUNNER_ROOT/koth-production-runner"
[[ -x "$launcher" ]]
cmp "$ROOT/deploy/runner/run" "$launcher"
[[ "$(grep -Fc '*/5 * * * * ~/duckdns/duck.sh >/dev/null 2>&1' "$CRONTAB_STATE")" == "1" ]]
[[ "$(grep -Fc '# BEGIN koth-production-runner' "$CRONTAB_STATE")" == "1" ]]
[[ "$(grep -Fc '# END koth-production-runner' "$CRONTAB_STATE")" == "1" ]]
[[ "$(grep -Fc "* * * * * $RUNNER_ROOT/koth-production-runner >/dev/null 2>&1" "$CRONTAB_STATE")" == "1" ]]
if grep -Fq '/obsolete/runner' "$CRONTAB_STATE"; then
  printf 'obsolete runner cron entry was not replaced\n' >&2
  exit 1
fi
[[ "$(cat "$NOHUP_LOG")" == "$launcher" ]]

bash "$ROOT/deploy/runner/activate" "$ROOT/deploy/runner/run"
wait_for_line_count "$NOHUP_LOG" 2
[[ "$(grep -Fc '# BEGIN koth-production-runner' "$CRONTAB_STATE")" == "1" ]]
[[ "$(grep -Fc "* * * * * $RUNNER_ROOT/koth-production-runner >/dev/null 2>&1" "$CRONTAB_STATE")" == "1" ]]
[[ "$(wc -l <"$NOHUP_LOG" | tr -d '[:space:]')" == "2" ]]

bash "$launcher"
[[ "$(cat "$FLOCK_LOG")" == "-n -F $RUNNER_ROOT/.koth-production-runner.lock ./bin/runsvc.sh" ]]

cat >"$CRONTAB_STATE" <<'EOF'
*/5 * * * * ~/duckdns/duck.sh >/dev/null 2>&1
# BEGIN koth-production-runner
15 * * * * /must/not/be/deleted
EOF
cp "$CRONTAB_STATE" "$TEMP_DIR/malformed-crontab"
if bash "$ROOT/deploy/runner/activate" "$ROOT/deploy/runner/run" >/dev/null 2>&1; then
  printf 'malformed runner markers must reject activation\n' >&2
  exit 1
fi
cmp "$TEMP_DIR/malformed-crontab" "$CRONTAB_STATE"

cat >"$CRONTAB_STATE" <<'EOF'
*/5 * * * * ~/duckdns/duck.sh >/dev/null 2>&1
EOF
cp "$CRONTAB_STATE" "$TEMP_DIR/unreadable-crontab"
export CRONTAB_LIST_ERROR='permission denied'
if bash "$ROOT/deploy/runner/activate" "$ROOT/deploy/runner/run" >/dev/null 2>&1; then
  printf 'unexpected crontab read failures must reject activation\n' >&2
  exit 1
fi
unset CRONTAB_LIST_ERROR
cmp "$TEMP_DIR/unreadable-crontab" "$CRONTAB_STATE"

printf 'runner activation is user-owned, idempotent, and preserves cron entries\n'
