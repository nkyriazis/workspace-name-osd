#!/bin/bash
# Runs the extension from this repo in a headless nested GNOME Shell with
# throwaway settings and extension folders; the real desktop is untouched.
#
#   tests/run.sh           run the self-test
#   tests/run.sh shots     regenerate README screenshots into docs/
#                          (with several monitors, into docs/pr-evidence/all-monitors/)
#
# WSOSD_MONITORS sets the virtual monitors, e.g. "1920x1080 1280x1024".
# The default is one 1920x1080 monitor.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(dirname "$HERE")
UUID=workspace-name-osd@nkyriazis.github.com
MODE=${1:-test}

if [ -z "${WSOSD_INNER:-}" ]; then
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  EXT="$TMP/data/gnome-shell/extensions"
  mkdir -p "$EXT" "$TMP/config"
  cp -r "$REPO/$UUID" "$EXT/"
  glib-compile-schemas "$EXT/$UUID/schemas"
  case $MODE in
    test)  DRIVER=selftest@workspace-name-osd;    TAG=OSDTEST ;;
    shots) DRIVER=screenshots@workspace-name-osd; TAG=OSDSHOT ;;
    *) echo "usage: $0 [test|shots]"; exit 2 ;;
  esac
  cp -r "$HERE/$DRIVER" "$EXT/"
  OUT="$REPO/docs"
  set -- ${WSOSD_MONITORS:-1920x1080}
  [ $# -gt 1 ] && OUT="$REPO/docs/pr-evidence/all-monitors"
  [ "$MODE" = shots ] && mkdir -p "$OUT"
  WSOSD_INNER=1 WSOSD_DRIVER=$DRIVER WSOSD_TAG=$TAG WSOSD_LOG="$TMP/shell.log" \
    WSOSD_SHOTS="$REPO/docs" WSOSD_MONITORS="${WSOSD_MONITORS:-1920x1080}" XDG_CONFIG_HOME="$TMP/config" XDG_DATA_HOME="$TMP/data" \
    dbus-run-session -- "$0" "$MODE" > /dev/null 2>&1
  grep "$TAG" "$TMP/shell.log" | sed "s/.*$TAG //"
  if [ "$MODE" = shots ]; then
    python3 - "$OUT" <<'PY'
import sys, pathlib
from PIL import Image
for f in pathlib.Path(sys.argv[1]).glob("*.png"):
    im = Image.open(f).convert("RGB")
    # Multi-monitor shots are wide; keep them readable.
    im.thumbnail((2400, 720) if im.size[0] > 2 * im.size[1] else (1280, 720), Image.LANCZOS)
    im.save(f, optimize=True)
    print(f"resized {f.name} to {im.size[0]}x{im.size[1]}, {f.stat().st_size // 1024} KB")
PY
  fi
  ERRS=$(grep -A8 'JS ERROR' "$TMP/shell.log" | grep -c "$UUID")
  echo "errors from extension: $ERRS"
  if grep -q "$TAG DONE failures=0\|$TAG DONE$" "$TMP/shell.log" && [ "$ERRS" = 0 ]; then
    exit 0
  fi
  # Without this a failure on CI leaves nothing to go on.
  echo "--- last 150 lines of the nested shell's log" >&2
  tail -n 150 "$TMP/shell.log" >&2
  exit 1
fi

gsettings set org.gnome.shell enabled-extensions "['$UUID', '$WSOSD_DRIVER']"
gsettings set org.gnome.mutter dynamic-workspaces false
gsettings set org.gnome.desktop.wm.preferences num-workspaces 4
if [ "$WSOSD_DRIVER" = screenshots@workspace-name-osd ]; then
  gsettings set org.gnome.desktop.wm.preferences workspace-names "['mail', 'thesis', 'code', 'music']"
  gsettings set org.gnome.desktop.interface color-scheme prefer-dark
  # Plain gradient: no wallpaper artwork to license, nothing behind the text.
  for k in picture-uri picture-uri-dark; do gsettings set org.gnome.desktop.background $k ''; done
  gsettings set org.gnome.desktop.background picture-options none
  gsettings set org.gnome.desktop.background color-shading-type vertical
  gsettings set org.gnome.desktop.background primary-color '#2a4d6e'
  gsettings set org.gnome.desktop.background secondary-color '#0f1c2b'
else
  gsettings set org.gnome.desktop.wm.preferences workspace-names "['one', 'two', 'three', 'four']"
fi
# Test windows must only ever reach the nested shell.
unset DISPLAY WAYLAND_DISPLAY
MONITOR_ARGS=()
for m in $WSOSD_MONITORS; do MONITOR_ARGS+=(--virtual-monitor "$m"); done
gnome-shell --headless "${MONITOR_ARGS[@]}" > "$WSOSD_LOG" 2>&1 &
PID=$!
for _ in $(seq 1 180); do grep -q "$WSOSD_TAG DONE" "$WSOSD_LOG" && break; sleep 1; done
sleep 1; kill $PID 2>/dev/null; sleep 2; kill -9 $PID 2>/dev/null
