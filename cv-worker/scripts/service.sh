#!/bin/bash

set -euo pipefail

label="com.koth-company.cv-worker"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
worker_directory="$(cd "$script_directory/.." && pwd -P)"
repository_directory="$(cd "$worker_directory/.." && pwd -P)"
template_path="$worker_directory/launchd/$label.plist"
runner_path="$script_directory/run-production-service.sh"
launch_agents_directory="$HOME/Library/LaunchAgents"
plist_path="$launch_agents_directory/$label.plist"
log_directory="$HOME/Library/Logs/koth-company"
stdout_path="$log_directory/cv-worker.log"
stderr_path="$log_directory/cv-worker.error.log"
domain="gui/$(id -u)"
service_target="$domain/$label"

usage() {
  cat <<EOF
Usage: $0 <command>

Commands:
  install          Install and start the production CV worker LaunchAgent
  status           Show the current LaunchAgent state
  logs [--follow]  Show the last 100 stdout and stderr lines
  restart          Restart the installed LaunchAgent
  uninstall        Stop and remove the LaunchAgent
EOF
}

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "The CV worker LaunchAgent is supported only on macOS" >&2
    exit 1
  fi
}

is_loaded() {
  launchctl print "$service_target" >/dev/null 2>&1
}

install_service() {
  require_macos

  local environment_file="$repository_directory/.env.local"
  if [[ ! -r "$environment_file" ]]; then
    echo "Missing readable environment file: $environment_file" >&2
    exit 1
  fi

  local environment_mode
  environment_mode="$(stat -f '%Lp' "$environment_file")"
  if (( (8#$environment_mode) & 077 )); then
    echo "$environment_file must not be readable by group or other users (current mode: $environment_mode)" >&2
    exit 1
  fi

  local uv_path
  uv_path="$(command -v uv || true)"
  if [[ "$uv_path" != /* || ! -x "$uv_path" ]]; then
    echo "Install uv and ensure it is available as an absolute executable path" >&2
    exit 1
  fi

  if [[ ! -x "$runner_path" ]]; then
    echo "Production runner is not executable: $runner_path" >&2
    exit 1
  fi

  umask 077
  mkdir -p "$launch_agents_directory" "$log_directory"
  chmod 700 "$log_directory"
  touch "$stdout_path" "$stderr_path"
  chmod 600 "$stdout_path" "$stderr_path"

  local generated_plist
  generated_plist="$(mktemp "${TMPDIR:-/tmp}/$label.XXXXXX")"
  trap 'rm -f "$generated_plist"' EXIT
  cp "$template_path" "$generated_plist"
  plutil -replace ProgramArguments -json "[\"$runner_path\", \"$uv_path\"]" "$generated_plist"
  plutil -replace WorkingDirectory -string "$worker_directory" "$generated_plist"
  plutil -replace StandardOutPath -string "$stdout_path" "$generated_plist"
  plutil -replace StandardErrorPath -string "$stderr_path" "$generated_plist"
  plutil -lint "$generated_plist" >/dev/null

  local reloading=false
  if is_loaded; then
    launchctl bootout "$service_target"
    reloading=true
  fi
  install -m 600 "$generated_plist" "$plist_path"
  launchctl enable "$service_target"
  if [[ "$reloading" == true ]]; then
    # launchd may still be retiring the prior process when bootout returns.
    sleep 1
  fi
  launchctl bootstrap "$domain" "$plist_path"

  rm -f "$generated_plist"
  trap - EXIT

  echo "Installed and started $service_target"
  echo "Logs: $stdout_path and $stderr_path"
}

show_status() {
  require_macos
  if ! is_loaded; then
    echo "$service_target is not loaded" >&2
    exit 3
  fi
  launchctl print "$service_target"
}

show_logs() {
  local follow="${1:-}"
  if [[ -n "$follow" && "$follow" != "--follow" ]]; then
    usage >&2
    exit 2
  fi
  local options=(-n 100)
  if [[ "$follow" == "--follow" ]]; then
    options+=(-F)
  fi
  tail "${options[@]}" "$stdout_path" "$stderr_path"
}

restart_service() {
  require_macos
  if ! is_loaded; then
    echo "$service_target is not loaded; run '$0 install' first" >&2
    exit 3
  fi
  launchctl kickstart -k "$service_target"
}

uninstall_service() {
  require_macos
  if is_loaded; then
    launchctl bootout "$service_target"
  fi
  rm -f "$plist_path"
  echo "Uninstalled $service_target; logs remain in $log_directory"
}

case "${1:-}" in
  install)
    install_service
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs "${2:-}"
    ;;
  restart)
    restart_service
    ;;
  uninstall)
    uninstall_service
    ;;
  help | --help | -h)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
