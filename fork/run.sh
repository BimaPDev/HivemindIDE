#!/usr/bin/env bash
# Launch the fork from source.
#
# Exists because ./scripts/code.sh inherits your shell's environment, and if you
# run it from a terminal inside VS Code, Cursor or any Electron editor, that
# environment contains ELECTRON_RUN_AS_NODE=1 and a dozen VSCODE_* variables
# belonging to the *host* editor. The fork then boots its main process as plain
# Node and dies with:
#
#   SyntaxError: The requested module 'electron' does not provide an export
#   named 'Menu'
#
# which looks like a broken build and is not one. This script strips them.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/editor-dir.sh"
EDITOR_DIR="$(hivemindide_editor_dir)"
[ -d "$EDITOR_DIR" ] || { echo "no checkout at $EDITOR_DIR" >&2; exit 1; }

# The build is pinned to the Node version in .nvmrc and misbehaves on others.
NODE_VERSION="$(tr -d 'v \r\n' < "$EDITOR_DIR/.nvmrc")"
NODE_BIN="$HOME/.nvm/versions/node/v${NODE_VERSION}/bin"
if [ -d "$NODE_BIN" ]; then
  export PATH="$NODE_BIN:$PATH"
else
  echo "warning: node ${NODE_VERSION} not found under nvm; using $(node -v)" >&2
fi

# Upstream preLaunch only checks that out/ exists. Heal incomplete trees here.
"$SCRIPT_DIR/ensure-out.sh" "$EDITOR_DIR"

cd "$EDITOR_DIR"
exec env \
  -u ELECTRON_RUN_AS_NODE \
  -u VSCODE_PID \
  -u VSCODE_IPC_HOOK \
  -u VSCODE_CWD \
  -u VSCODE_NLS_CONFIG \
  -u VSCODE_CODE_CACHE_PATH \
  -u VSCODE_ESM_ENTRYPOINT \
  -u VSCODE_CRASH_REPORTER_PROCESS_TYPE \
  -u VSCODE_HANDLES_UNCAUGHT_ERRORS \
  -u VSCODE_PROCESS_TITLE \
  -u VSCODE_L10N_BUNDLE_LOCATION \
  -u NoDefaultCurrentDirectoryInExePath \
  ./scripts/code.sh "$@"
