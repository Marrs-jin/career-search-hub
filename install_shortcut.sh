#!/usr/bin/env bash
# One-time setup: makes the launcher executable and adds a "Daily Hub" shortcut
# to your desktop and your applications menu. Safe to run again.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
chmod +x "$DIR/launch_hub.sh" "$DIR/install_shortcut.sh"
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || true)"; [ -d "$DESK" ] || DESK="$HOME/Desktop"
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS" "$DESK"
make_entry() {
cat > "$1" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=Daily Hub
Comment=Job search desk: today's plan, search, records, goals
Exec=bash "$DIR/launch_hub.sh"
Path=$DIR
Icon=$DIR/static/icon.svg
Terminal=false
Categories=Office;
StartupNotify=false
DESKTOP
chmod +x "$1"
}
make_entry "$APPS/daily-hub.desktop"
make_entry "$DESK/Daily Hub.desktop"
# GNOME asks you to trust desktop files once; this does it when the tool exists.
command -v gio >/dev/null 2>&1 && gio set "$DESK/Daily Hub.desktop" metadata::trusted true 2>/dev/null || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true
echo "Done."
echo "  Launcher:  $DIR/launch_hub.sh  (executable)"
echo "  Shortcut:  $DESK/Daily Hub.desktop"
echo "  Menu:      $APPS/daily-hub.desktop"
echo "If the desktop icon shows a warning, right-click it and choose Allow Launching (or Trust and Launch)."
