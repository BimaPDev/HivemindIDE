# Sourced by the fork scripts. Prints a Node binary that can start run.mjs.
#
# Prefers the version in the editor's .nvmrc. Install locations match
# candidateNodeBins in launch.mjs. The launcher re-checks the version and
# switches if this pick is wrong.
hivemindide_node_bin() {
	local editor_dir="$1"
	local version="" home_dir bin root
	if [ -f "$editor_dir/.nvmrc" ]; then
		version="$(tr -d 'v \r\n' < "$editor_dir/.nvmrc")"
	fi
	home_dir="$(eval echo "~$(id -un)")"
	[ -d "$home_dir" ] || home_dir="${HOME:-}"

	pick() {
		if [ -n "${1:-}" ] && [ -x "$1" ]; then
			echo "$1"
			return 0
		fi
		return 1
	}

	if [ -n "$version" ]; then
		bin="$(pick "${NVM_DIR:-$home_dir/.nvm}/versions/node/v${version}/bin/node" || true)"
		if [ -z "$bin" ]; then
			local roots=()
			[ -n "${FNM_DIR:-}" ] && roots+=("$FNM_DIR")
			roots+=(
				"$home_dir/.local/share/fnm"
				"$home_dir/.fnm"
				"$home_dir/Library/Application Support/fnm"
			)
			for root in "${roots[@]}"; do
				bin="$(pick "$root/node-versions/v${version}/installation/bin/node" || true)"
				[ -n "$bin" ] && break
			done
		fi
		if [ -z "$bin" ]; then
			bin="$(pick "$home_dir/.volta/tools/image/node/${version}/bin/node" || true)"
		fi
		if [ -z "$bin" ]; then
			bin="$(pick "$home_dir/.asdf/installs/nodejs/${version}/bin/node" || true)"
		fi
		if [ -z "$bin" ]; then
			bin="$(pick "$home_dir/.local/share/mise/installs/node/${version}/bin/node" || true)"
		fi
	fi
	if [ -z "$bin" ] && command -v node >/dev/null 2>&1; then
		bin="$(command -v node)"
	fi
	if [ -z "$bin" ]; then
		echo "node is required. Install Node ${version:-24.18.0} (hivemindide-editor/.nvmrc)." >&2
		return 1
	fi
	echo "$bin"
}
