#!/bin/sh
# Computes the size of the backup (af-backup --compute-size) for the destination folder this script lies in,
# without making the backup and waits for a key before the window closes,
# so that the result stays readable. Finder opens a .command file in a Terminal window by a double click.
# Copy this file into the destination folder next to af-backup-task.json, make it executable
# (chmod +x run-af-backup-compute-size.command) and double-click it.

wait_for_key() {
  printf '%s' 'Press any key to close this window...'

  if [ -t 0 ]; then
    saved_terminal_settings=$(stty -g)
    stty -icanon -echo min 1 time 0
    dd bs=1 count=1 >/dev/null 2>&1
    stty "$saved_terminal_settings"
  fi

  echo
}

cd "$(dirname "$0")" || exit 1

if ! command -v af-backup >/dev/null 2>&1; then
  echo 'af-backup is not found in PATH (installed with "npm install -g ."; with nvm add its PATH setup'
  echo 'to ~/.zprofile, which Terminal reads for a .command file).'
  wait_for_key
  exit 2
fi

# Ctrl+C is handled by af-backup itself (a graceful stop); the script only keeps going to show the result
trap ':' INT
af-backup --compute-size
exit_code=$?
trap - INT

echo
echo "af-backup --compute-size finished with exit code $exit_code (0 - no errors; see the lines above)."
wait_for_key
exit "$exit_code"
