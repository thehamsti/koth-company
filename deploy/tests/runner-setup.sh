#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
RUNNER_ROOT="$TEMP_DIR/runner"
COMMAND_LOG="$TEMP_DIR/commands.log"
export RUNNER_ROOT COMMAND_LOG

mkdir -p "$TEMP_DIR/bin" "$RUNNER_ROOT"
touch "$RUNNER_ROOT/.runner"
cat >"$TEMP_DIR/bin/flock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'flock <%s>\n' "$*" >>"$COMMAND_LOG"
EOF
cat >"$TEMP_DIR/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl <%s>\n' "$*" >>"$COMMAND_LOG"
exit 99
EOF
cat >"$TEMP_DIR/activate" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if { true >&8; } 2>/dev/null; then
  printf 'setup lock leaked into activator\n' >&2
  exit 1
fi
if IFS= read -r leaked_token; then
  printf 'registration token leaked into activator: %s\n' "$leaked_token" >&2
  exit 1
fi
printf 'activate <%s>\n' "$*" >>"$COMMAND_LOG"
EOF
printf '#!/usr/bin/env bash\nexit 0\n' >"$TEMP_DIR/run"
chmod 0700 "$TEMP_DIR/bin/"* "$TEMP_DIR/activate" "$TEMP_DIR/run"
export PATH="$TEMP_DIR/bin:$PATH"

output="$(printf 'short-lived-token\n' | bash "$ROOT/deploy/runner/setup" "$TEMP_DIR/activate" "$TEMP_DIR/run")"
grep -Fq "runner already registered and activated at $RUNNER_ROOT" <<<"$output"
grep -Fq 'flock <8>' "$COMMAND_LOG"
grep -Fq "activate <$TEMP_DIR/run>" "$COMMAND_LOG"
if grep -Fq 'curl <' "$COMMAND_LOG"; then
  printf 'an existing registration must not download another runner\n' >&2
  exit 1
fi

printf 'runner setup serializes and reactivates existing registrations\n'
