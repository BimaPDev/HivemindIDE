#!/usr/bin/env bash
# Ensure hivemindide-editor/out is bootable.
#
# Upstream preLaunch only checks that `out/` exists, not that it is complete.
# A failed `gulp compile` (clean-out + TS errors) leaves a half-empty tree and
# ./fork/run.sh then dies on the first missing module (often ipc.js).
#
# Also: raw `tsc -p src/tsconfig.json` emits into out/vs/vs/ because rootDir
# resolves to src/. We flatten that nesting when we see it.
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/editor-dir.sh"
EDITOR_DIR="${1:-$(hivemindide_editor_dir)}"
SENTINEL="$EDITOR_DIR/out/vs/base/parts/ipc/common/ipc.js"
NESTED="$EDITOR_DIR/out/vs/vs/base/parts/ipc/common/ipc.js"

cd "$EDITOR_DIR"

NODE_VERSION="$(tr -d 'v \r\n' < .nvmrc 2>/dev/null || true)"
if [ -n "${NODE_VERSION:-}" ] && [ -d "$HOME/.nvm/versions/node/v${NODE_VERSION}/bin" ]; then
	export PATH="$HOME/.nvm/versions/node/v${NODE_VERSION}/bin:$PATH"
fi

flatten_nested_out() {
	if [ -d out/vs/vs ]; then
		echo "==> flattening out/vs/vs → out/vs"
		rsync -a out/vs/vs/ out/vs/
		rm -rf out/vs/vs
	fi
}

# tsc emits .js only. gulp compile also copies .css; without that, a single
# missing `import './media/foo.css'` fails the whole workbench.desktop.main
# dynamic import (ERR_FAILED) and leaves the splash + DevTools open.
sync_css() {
	local missing=0
	while IFS= read -r srcpath; do
		local outpath="${srcpath/#src\//out/}"
		if [ ! -f "$outpath" ] || [ "$srcpath" -nt "$outpath" ]; then
			mkdir -p "$(dirname "$outpath")"
			cp -f "$srcpath" "$outpath"
			missing=$((missing + 1))
		fi
	done < <(find src/vs -name '*.css' -print)
	if [ "$missing" -gt 0 ]; then
		echo "==> synced $missing css file(s) into out/"
	fi
}

rebuild_out() {
	echo "==> rebuilding out/ (this takes a minute)"
	node node_modules/@typescript/native/bin/tsc \
		--project src/tsconfig.json \
		--pretty false \
		--sourceMap \
		--inlineSources \
		--noEmitOnError false
	flatten_nested_out
	sync_css

	# Keep HivemindIDE contrib current (agent tree lives only in our files).
	if command -v npx >/dev/null 2>&1; then
		mkdir -p out/vs/workbench/contrib/hivemindide/browser/media
		cp -f src/vs/workbench/contrib/hivemindide/browser/media/*.css \
			out/vs/workbench/contrib/hivemindide/browser/media/ 2>/dev/null || true
		npx --yes esbuild \
			src/vs/workbench/contrib/hivemindide/common/agentTree.ts \
			src/vs/workbench/contrib/hivemindide/browser/agentTreeWidget.ts \
			src/vs/workbench/contrib/hivemindide/browser/agentTreeViewPane.ts \
			src/vs/workbench/contrib/hivemindide/browser/agentDetailWidget.ts \
			src/vs/workbench/contrib/hivemindide/browser/agentTree.contribution.ts \
			src/vs/workbench/contrib/hivemindide/browser/hivemindide.contribution.ts \
			src/vs/workbench/services/hivemindide/common/coordinationClient.ts \
			--outdir=out/vs/workbench \
			--outbase=src/vs/workbench \
			--format=esm \
			--platform=neutral \
			--target=es2022 \
			--sourcemap >/dev/null
	fi
}

sync_css

if [ -f "$SENTINEL" ]; then
	exit 0
fi

if [ -f "$NESTED" ]; then
	flatten_nested_out
	[ -f "$SENTINEL" ] && exit 0
fi

rebuild_out

if [ ! -f "$SENTINEL" ]; then
	echo "error: still missing $SENTINEL after rebuild" >&2
	exit 1
fi

echo "==> out/ ready"
