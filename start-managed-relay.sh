#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ ! -d "$SCRIPT_DIR/managed-relay-runtime/node_modules/toml-eslint-parser" ] || [ ! -d "$SCRIPT_DIR/managed-relay-runtime/node_modules/proxy-agent" ] || [ ! -d "$SCRIPT_DIR/managed-relay-runtime/node_modules/proxy-from-env" ] || [ ! -d "$SCRIPT_DIR/managed-relay-runtime/node_modules/parse5" ]; then
  npm ci --prefix "$SCRIPT_DIR/managed-relay-runtime" --ignore-scripts --no-audit --no-fund
fi
exec node "$SCRIPT_DIR/managed-relay-server.js" "$@"
