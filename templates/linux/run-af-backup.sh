#!/bin/sh
# Starts af-backup for the destination folder this script lies in, in its own terminal window,
# and waits for a key before the window closes, so that the result stays readable.
# Copy this file into the destination folder next to af-backup-task.json, make it executable
# (chmod +x run-af-backup.sh) and run it from a terminal or from the file manager.

script="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

# Started without a terminal (from the file manager): open one and run this script in it
if [ ! -t 0 ] && [ -z "$AF_BACKUP_IN_TERMINAL" ]; then
  export AF_BACKUP_IN_TERMINAL=1

  for terminal in x-terminal-emulator gnome-terminal konsole xfce4-terminal xterm; do
    if command -v "$terminal" >/dev/null 2>&1; then
      case "$terminal" in
        gnome-terminal) exec gnome-terminal -- "$script" ;;
        xfce4-terminal) exec xfce4-terminal -x "$script" ;;
        *) exec "$terminal" -e "$script" ;;
      esac
    fi
  done
fi

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

cd "$(dirname "$script")" || exit 1

if ! command -v af-backup >/dev/null 2>&1; then
  echo 'af-backup is not found in PATH (installed with "npm install -g ."; with nvm the PATH of a terminal'
  echo 'started from the file manager may lack it - run this script from your usual terminal).'
  wait_for_key
  exit 2
fi

# Ctrl+C is handled by af-backup itself (a graceful stop); the script only keeps going to show the result
trap ':' INT
af-backup
exit_code=$?
trap - INT

echo
if [ "$exit_code" -eq 0 ]; then
  echo 'Backup completed successfully.'
else
  echo "af-backup finished with exit code $exit_code (0 - success; see the lines above)."
fi
wait_for_key
exit "$exit_code"
