#!/bin/bash
# Prints the release version (version-name in metadata.json).
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version-name"])' \
  "$(dirname "$0")/../workspace-name-osd@nkyriazis.github.com/metadata.json"
