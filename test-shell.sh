#!/usr/bin/env bash
# Runs a GNOME Shell in a window (mutter-devkit) with Workspace Lanes
# enabled, isolated from your own session: it gets a throwaway home folder
# and settings, so nothing you change in it (accent colour, workspaces,
# extensions) touches your real setup. Close the window to stop it.
#
#   ./test-shell.sh                  one 1920x1080 monitor
#   ./test-shell.sh 1920x1080 1280x1024   one monitor per size given
#
# Needs mutter-devkit (e.g. `sudo dnf install mutter-devkit` on Fedora).
set -euo pipefail

UUID="workspace-lanes@truenorth-tools"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
MONITORS=("${@:-1920x1080}")

if [[ -z "${WAYLAND_DISPLAY:-}" ]]; then
    echo "Run this from a Wayland session." >&2
    exit 1
fi

TMP="$(mktemp -d -t workspace-lanes-test.XXXXXX)"
SHELL_PID=

# Stop the test session's own services (portals, gvfs and so on, found by
# their throwaway runtime folder), unmount what they mounted, then delete
# the folder
cleanup() {
    [[ -n "$SHELL_PID" ]] && kill "$SHELL_PID" 2>/dev/null
    for p in $(pgrep -u "$(id -u)"); do
        tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null |
            grep -qxF "XDG_RUNTIME_DIR=$TMP/runtime" && kill "$p" 2>/dev/null
    done
    sleep 1
    awk -v dir="$TMP/" 'index($2, dir) == 1 {print $2}' /proc/mounts |
        while read -r mount; do fusermount3 -u "$mount" 2>/dev/null || true; done
    rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
mkdir -p "$TMP"/{home,config/glib-2.0/settings,data/gnome-shell/extensions,cache,runtime}
chmod 700 "$TMP/runtime"

glib-compile-schemas --strict "$SRC/schemas"
# a link, so code edits show up the next time you start it
ln -s "$SRC" "$TMP/data/gnome-shell/extensions/$UUID"

# start from your wallpaper, light/dark style and accent colour (read only)
get() { gsettings get "$1" "$2" 2>/dev/null || echo "$3"; }
cat > "$TMP/config/glib-2.0/settings/keyfile" <<EOF
[org/gnome/shell]
enabled-extensions=['$UUID']
welcome-dialog-last-shown-version='999'

[org/gnome/desktop/interface]
color-scheme=$(get org.gnome.desktop.interface color-scheme "'default'")
accent-color=$(get org.gnome.desktop.interface accent-color "'blue'")

[org/gnome/desktop/background]
picture-uri=$(get org.gnome.desktop.background picture-uri "''")
picture-uri-dark=$(get org.gnome.desktop.background picture-uri-dark "''")
EOF

monitorArgs=()
for m in "${MONITORS[@]}"; do
    monitorArgs+=(--virtual-monitor "$m")
done

# the devkit window still needs your display and PipeWire, so point at
# them directly before swapping in the throwaway runtime folder
HOST_RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
[[ "$WAYLAND_DISPLAY" == /* ]] || WAYLAND_DISPLAY="$HOST_RUNTIME/$WAYLAND_DISPLAY"

env HOME="$TMP/home" \
    XDG_CONFIG_HOME="$TMP/config" \
    XDG_DATA_HOME="$TMP/data" \
    XDG_CACHE_HOME="$TMP/cache" \
    XDG_RUNTIME_DIR="$TMP/runtime" \
    WAYLAND_DISPLAY="$WAYLAND_DISPLAY" \
    PIPEWIRE_RUNTIME_DIR="$HOST_RUNTIME" \
    GSETTINGS_BACKEND=keyfile \
    dbus-run-session -- gnome-shell --devkit --wayland-display wt-test "${monitorArgs[@]}" &
SHELL_PID=$!
wait "$SHELL_PID" || true
