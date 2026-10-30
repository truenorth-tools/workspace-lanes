#!/usr/bin/env bash
# Links Workspace Lanes into GNOME's extensions folder and, once GNOME
# Shell has picked it up, swaps it in for the built-in Window List.
#
# On Wayland GNOME Shell only notices a newly installed extension after you
# log out and back in, so the first run installs and the second (after
# logging back in) switches over.
set -euo pipefail

UUID="workspace-lanes@truenorth-tools"
WINDOW_LIST="window-list@gnome-shell-extensions.gcampax.github.com"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas --strict "$SRC/schemas"

mkdir -p "$(dirname "$DEST")"
if [[ -L "$DEST" || ! -e "$DEST" ]]; then
    ln -sfn "$SRC" "$DEST"
else
    echo "$DEST exists and is not a symlink; leaving it alone." >&2
    exit 1
fi
echo "Linked $DEST -> $SRC"

if gnome-extensions info "$UUID" &>/dev/null; then
    gnome-extensions enable "$UUID"
    gnome-extensions disable "$WINDOW_LIST" 2>/dev/null || true
    echo "Workspace Lanes enabled; Window List disabled."
    echo "To go back: gnome-extensions disable $UUID && gnome-extensions enable $WINDOW_LIST"
else
    echo "GNOME Shell hasn't seen the extension yet."
    echo "Log out and back in, then run this script again to switch over."
fi
