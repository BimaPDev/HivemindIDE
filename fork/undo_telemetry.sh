#!/usr/bin/env bash
# Neutralise hard-coded Microsoft telemetry endpoints in the editor tree.
#
# Same approach as VSCodium's undo_telemetry.sh: any host matching
# *.data.microsoft.com (vortex, mobile.events, …) is rewritten to 0.0.0.0 so
# even if a code path still fires with enableTelemetry somehow on, the packet
# goes nowhere.
#
# Idempotent. Re-run after every upstream merge.
set -euo pipefail

EDITOR_DIR="${HIVEMINDIDE_EDITOR_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/hivemindide-editor}"
[ -d "$EDITOR_DIR" ] || { echo "no checkout at $EDITOR_DIR" >&2; exit 1; }

SEARCH='\.data\.microsoft\.com'
# BSD and GNU sed both accept -E; -i '' is macOS, -i is GNU — detect.
if sed --version >/dev/null 2>&1; then
	SED_INPLACE=(sed -i -E)
else
	SED_INPLACE=(sed -i '' -E)
fi
REPLACEMENT='s|//[^/]+\.data\.microsoft\.com|//0.0.0.0|g'

log() { printf '\033[1m==> %s\033[0m\n' "$1"; }

cd "$EDITOR_DIR"

# Prefer the vscode-bundled ripgrep when node_modules is present; fall back to
# system rg / grep so this still runs before npm install.
if [ -x ./node_modules/@vscode/ripgrep/bin/rg ]; then
	RG=(./node_modules/@vscode/ripgrep/bin/rg --no-ignore -l)
elif command -v rg >/dev/null; then
	RG=(rg --no-ignore -l)
else
	RG=()
fi

log "neutering Microsoft telemetry URLs (*.data.microsoft.com → 0.0.0.0)"

found=0
if [ ${#RG[@]} -gt 0 ]; then
	# Exclude node_modules / .git / out / .build — those are regenerated and
	# rewriting them just slows the script and dirties a huge tree.
	while IFS= read -r -d '' file; do
		"${SED_INPLACE[@]}" "$REPLACEMENT" "$file"
		found=$((found + 1))
	done < <("${RG[@]}" --glob '!node_modules/**' --glob '!.git/**' --glob '!out/**' --glob '!.build/**' --glob '!**/*.map' -0 "$SEARCH" . || true)
else
	while IFS= read -r file; do
		"${SED_INPLACE[@]}" "$REPLACEMENT" "$file"
		found=$((found + 1))
	done < <(grep -rl --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=out --exclude-dir=.build -E "$SEARCH" . || true)
fi

printf '  rewrote %s file(s)\n' "$found"
