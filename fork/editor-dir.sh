# Sourced by the fork scripts. Prints the editor checkout's path.
#
# $HIVEMINDIDE_EDITOR_DIR wins. Otherwise the documented sibling
# (../hivemindide-editor), then a checkout nested inside this repo — which
# .gitignore excludes so it can never be committed here by accident.
hivemindide_editor_dir() {
	local repo
	repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
	if [ -n "${HIVEMINDIDE_EDITOR_DIR:-}" ]; then
		echo "$HIVEMINDIDE_EDITOR_DIR"
	elif [ -d "$repo/../hivemindide-editor" ]; then
		(cd "$repo/../hivemindide-editor" && pwd)
	elif [ -d "$repo/hivemindide-editor" ]; then
		echo "$repo/hivemindide-editor"
	else
		echo "$(cd "$repo/.." && pwd)/hivemindide-editor"
	fi
}
