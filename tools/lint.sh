#!/bin/bash
# Runs Shexli, the static analyzer extensions.gnome.org suggests, on the zip
# and fails on any finding. Shexli itself exits 0 either way.
set -euo pipefail
ZIP=$(realpath "$1")
SHEXLI=${SHEXLI:-shexli}
"$SHEXLI" "$ZIP"
n=$("$SHEXLI" --format json "$ZIP" | python3 -c 'import json, sys; print(len(json.load(sys.stdin)["findings"]))')
[ "$n" = 0 ]
