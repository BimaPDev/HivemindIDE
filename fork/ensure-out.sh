#!/usr/bin/env bash
# Ensure hivemindide-editor/out is bootable. See ensure-out.mjs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/editor-dir.sh"
EDITOR_DIR="${1:-$(hivemindide_editor_dir)}"

. "$SCRIPT_DIR/node-bin.sh"
NODE_BIN="$(hivemindide_node_bin "$EDITOR_DIR")"
exec "$NODE_BIN" "$SCRIPT_DIR/ensure-out.mjs" "$EDITOR_DIR"
