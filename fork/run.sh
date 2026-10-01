#!/usr/bin/env bash
# Launch the fork from source on macOS and Linux.
# Windows: fork\run.cmd
#
# The work is in fork/run.mjs: it strips ELECTRON_RUN_AS_NODE and the host
# editor's VSCODE_* / Claude session variables, selects the Node version in
# .nvmrc, and runs scripts/code.sh (or scripts/code.bat on Windows).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$(uname -s 2>/dev/null || echo unknown)" in
	MINGW*|MSYS*|CYGWIN*)
		exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$SCRIPT_DIR/run.ps1")" "$@"
		;;
esac

. "$SCRIPT_DIR/editor-dir.sh"
EDITOR_DIR="$(hivemindide_editor_dir)"
[ -d "$EDITOR_DIR" ] || { echo "no checkout at $EDITOR_DIR" >&2; exit 1; }

. "$SCRIPT_DIR/node-bin.sh"
NODE_BIN="$(hivemindide_node_bin "$EDITOR_DIR")"
export PATH="$(dirname "$NODE_BIN"):$PATH"
exec "$NODE_BIN" "$SCRIPT_DIR/run.mjs" "$@"
