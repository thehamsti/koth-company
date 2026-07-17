#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
COMMAND_LOG="$TEMP_DIR/commands.log"
export COMMAND_LOG

mkdir -p "$TEMP_DIR/bin"
cat >"$TEMP_DIR/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'gh <%s>\n' "$*" >>"$COMMAND_LOG"
if [[ "${1:-}" == "auth" ]]; then
  exit 0
fi
if [[ "$*" == *'/registration-token'* ]]; then
  printf 'short-lived-token\n'
  exit 0
fi
printf 'online\n'
EOF
cat >"$TEMP_DIR/bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'ssh <%s>\n' "$*" >>"$COMMAND_LOG"
if [[ "${2:-}" == "mktemp -d /tmp/koth-production-runner-setup.XXXXXX" ]]; then
  printf '%s\n' "$FAKE_REMOTE_DIRECTORY"
  exit 0
fi
cat >/dev/null || true
EOF
cat >"$TEMP_DIR/bin/scp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'scp <%s>\n' "$*" >>"$COMMAND_LOG"
EOF
cat >"$TEMP_DIR/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod 0700 "$TEMP_DIR/bin/"*
export PATH="$TEMP_DIR/bin:$PATH"

: >"$COMMAND_LOG"
export FAKE_REMOTE_DIRECTORY='/tmp/koth-production-runner-setup.Ab12Cd'
output="$(bash "$ROOT/scripts/setup-production-runner")"
grep -Fq 'Production runner hamsti1-koth-production is online.' <<<"$output"
grep -Fq '/registration-token' "$COMMAND_LOG"
grep -Fq "/setup' '/tmp/koth-production-runner-setup.Ab12Cd/activate' '/tmp/koth-production-runner-setup.Ab12Cd/run'" "$COMMAND_LOG"

: >"$COMMAND_LOG"
export FAKE_REMOTE_DIRECTORY="/tmp/koth-production-runner-setup.safe'bad"
if bash "$ROOT/scripts/setup-production-runner" >/dev/null 2>&1; then
  printf 'unsafe remote temporary paths must be rejected\n' >&2
  exit 1
fi
if grep -Eq 'scp|rm -rf' "$COMMAND_LOG"; then
  printf 'unsafe remote temporary paths must not be copied to or removed\n' >&2
  exit 1
fi

: >"$COMMAND_LOG"
if KOTH_PRODUCTION_HOST=-V bash "$ROOT/scripts/setup-production-runner" >/dev/null 2>&1; then
  printf 'option-like production hosts must be rejected\n' >&2
  exit 1
fi
[[ ! -s "$COMMAND_LOG" ]]

printf 'runner setup validates remote input and confirms the listener online\n'
