# Sourced by the fork scripts. Prints the editor's path.
#
# $HIVEMINDIDE_EDITOR_DIR wins. Otherwise the editor tracked in this repo
# (./hivemindide-editor).
hivemindide_editor_dir() {
	local repo
	repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
	if [ -n "${HIVEMINDIDE_EDITOR_DIR:-}" ]; then
		echo "$HIVEMINDIDE_EDITOR_DIR"
	else
		echo "$repo/hivemindide-editor"
	fi
}
