#!/bin/bash
# Prints the CHANGELOG.md entry for a version, without its heading.
# Exits non-zero if there is no entry.
set -euo pipefail
V=$1
awk -v v="$V" '
  $0 ~ "^## " v " \\(" { found = 1; next }
  found && /^## /      { exit }
  found                { print }
  END                  { exit !found }
' "$(dirname "$0")/../CHANGELOG.md" | sed '/./,$!d'
