#!/usr/bin/env bash
# Start the Daily Hub and open it in your browser.
# Double-clicked from the desktop shortcut there is no terminal, so messages go to data/hub.log.
# Already running? hub.py just opens the existing page.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  msg="Python 3 is not installed. Install it with: sudo apt install python3"
  echo "$msg"; command -v notify-send >/dev/null 2>&1 && notify-send "Daily Hub" "$msg"; exit 1
fi
mkdir -p data
if [ -t 1 ]; then
  exec python3 hub.py "$@"
else
  exec python3 hub.py "$@" >> data/hub.log 2>&1
fi
