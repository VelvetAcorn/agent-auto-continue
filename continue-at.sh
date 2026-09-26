#!/bin/bash
# Send the prepared T3 Code message once, at tomorrow's 1am in London.
set -euo pipefail

usage() {
  echo "Usage: $0 [--dry-run] [--check] ['YYYY-MM-DD HH:MM:SS']"
  echo "Default: tomorrow at 01:00:00, Europe/London. Ctrl-C cancels."
}

dry_run=false
check_only=false
target=''
while (($#)); do
  case "$1" in
    --dry-run) dry_run=true ;;
    --check) check_only=true ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; exit 1 ;;
    *)
      if [[ -n "$target" ]]; then usage >&2; exit 1; fi
      target=$1
      ;;
  esac
  shift
done

if [[ $(uname -s) != Darwin ]]; then
  echo 'This script requires macOS.' >&2
  exit 1
fi
export TZ=Europe/London
target=${target:-$(date -v+1d '+%Y-%m-%d') 01:00:00}
target_epoch=$(date -j -f '%Y-%m-%d %H:%M:%S' "$target" '+%s')
if ((target_epoch <= $(date '+%s'))); then
  echo 'The scheduled time must be in the future.' >&2
  exit 1
fi
echo "Scheduled: $(date -r "$target_epoch" '+%A %d %B %Y, %H:%M:%S %Z')"
if $dry_run; then
  echo 'Dry run: no app interaction, waiting, or Enter press.'
  exit 0
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
helper="$script_dir/.build/press-continue"
if [[ ! -x "$helper" || "$script_dir/press-continue.swift" -nt "$helper" ]]; then
  echo 'Building the Mac helper (first run or after an update)...'
  mkdir -p "$script_dir/.build"
  /usr/bin/xcrun swiftc "$script_dir/press-continue.swift" -o "$helper"
fi
echo 'Checking T3 Code: leave the desired chat open with exactly continue in its focused input.'
thread_url=$("$helper" check)
if $check_only; then
  echo 'Preflight passed. Nothing sent or scheduled.'
  exit 0
fi

# Keep the Mac and display awake while waiting. This does not bypass screen locks
# or keep a laptop running with its lid closed.
/usr/bin/caffeinate -di -w $$ &
awake_pid=$!
trap 'kill "$awake_pid" 2>/dev/null || true' EXIT
trap 'echo "Cancelled."; exit 130' INT TERM
echo 'Armed. Keep this Terminal running, the lid open, and the Mac unlocked.'
echo 'Leave that same T3 chat open with continue in its input. Ctrl-C cancels.'

while true; do
  remaining=$((target_epoch - $(date '+%s')))
  if ((remaining <= 0)); then break; fi
  # Recheck the clock regularly, including after sleep or clock adjustments.
  if ((remaining > 30)); then remaining=30; fi
  sleep "$remaining"
done
if (( $(date '+%s') - target_epoch > 60 )); then
  echo 'Missed the scheduled time by over 60 seconds; nothing sent.' >&2
  exit 1
fi
"$helper" send "$thread_url"
echo "Enter pressed once at $(date '+%Y-%m-%d %H:%M:%S %Z')."
