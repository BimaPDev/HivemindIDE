# The fork

HivemindIDE forks **`microsoft/vscode` directly**, the way Cursor and Windsurf do —
not VSCodium.

## Why not VSCodium

VSCodium is not a source tree. It is a patch set plus build scripts: VS Code's
source is fetched *during* the build and patched by `patches/*.patch`. That is
an excellent way to ship a de-branded VS Code, and a bad way to build a product
on top of one. Every core change — the permission-filtered context, the presence
panel — would live as a `.patch` file to be re-rolled by hand on every upstream
bump.

Forking `microsoft/vscode` gives `src/vs/workbench/...` as real, editable,
committable code, and upstream arrives as a merge you resolve once.

What we give up is the de-branding, telemetry stripping and Open VSX config that
VSCodium hands over for free. That is [apply-branding.sh](apply-branding.sh)
plus [undo_telemetry.sh](undo_telemetry.sh) — the same outcomes as VSCodium's
`prepare_vscode.sh` / `undo_telemetry.sh` / `00-telemetry-disable.patch`, kept
as idempotent scripts against a real fork:

| VSCodium | HivemindIDE |
|---|---|
| Open VSX gallery | `product.json` → Open VSX |
| Strip Copilot / MS AI product hooks | delete `defaultChatAgent`, `voiceWsUrl`, … |
| `enableTelemetry` / defaults off | `enableTelemetry: false` + source defaults flipped |
| `*.data.microsoft.com` → `0.0.0.0` | `undo_telemetry.sh` |
| Drop `extensions/copilot` | remove from `build/npm/dirs.ts` |
| No Microsoft Marketplace | never pointed at it |

Re-run after every upstream merge. Never hand-edit `product.json` in the
checkout — change the script instead.

## Where it lives

The fork is **a sibling repository**, not a subdirectory:

```
Documents/Coding/
  HivemindIDE/          ← this repo: services, contract, docs
  hivemindide-editor/   ← the fork: full vscode history, own remote
```

Nesting it would put a 700MB repo with its own history inside this one. Keeping
them apart also matches the team split: Owner A owns the editor repo's history
end to end.

Point scripts at a different location with `HIVEMINDIDE_EDITOR_DIR`.

## Setting it up

```bash
git clone --filter=blob:none https://github.com/microsoft/vscode.git ../hivemindide-editor
./fork/apply-branding.sh
cd ../hivemindide-editor && npm install    # ~2 min, the step most likely to fail
npm run compile                         # ~1 min
cd - && ./fork/run.sh                   # launch it
```

`--filter=blob:none` keeps the full commit history — which you need, to merge
upstream — while fetching file contents lazily. A full clone is several GB more.

Node must match the checkout's `.nvmrc` exactly (24.18.0 as of VS Code 1.139).
The build breaks in confusing ways on the wrong major version, so `run.sh` puts
the right one on `PATH` for you.

### Use `fork/run.sh`, not `scripts/code.sh` directly

If you launch from a terminal *inside* VS Code or Cursor, you inherit that
editor's `ELECTRON_RUN_AS_NODE=1` and its `VSCODE_*` variables. The fork then
boots its main process as plain Node and dies with

```
SyntaxError: The requested module 'electron' does not provide an export named 'Menu'
```

which looks exactly like a broken build and is not one. `run.sh` strips those
variables. From a plain Terminal.app shell, `./scripts/code.sh` is fine.

### The dev instance writes to `code-oss-dev`

Running from source, the user-data directory is `code-oss-dev` no matter what
`product.json` says — upstream hardcodes it in `doGetUserDataPath` ("Running out
of sources has a fixed productName"). Packaged builds use the branded name. It
is not a branding miss, and it usefully keeps your dev instance's settings away
from any real install.

## Keeping up with upstream

```bash
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream && git merge upstream/main
./fork/apply-branding.sh    # idempotent; re-run after every merge
```

Two rules that decide how much pain this is:

**Keep changes in new files.** A new directory under
`src/vs/workbench/contrib/hivemindide/` never conflicts. Editing existing files
conflicts on every merge, so touch them only where you must — ideally only at
registration points, one line each.

**Never hand-edit `product.json` in the checkout.** Change
`apply-branding.sh` and re-run it, or the next merge conflict is yours to
untangle from memory.

## Adding features

[FEATURES.md](FEATURES.md) is the pattern: where a native feature lives, how its
setting gets into the Settings UI, and why "off" has to release resources rather
than hide UI. The usage indicator in
`src/vs/workbench/contrib/hivemindide/` is the worked example.

## Integration code

[integration/](integration/) holds the TypeScript that goes into the fork, with
the hook points for both phases written up — including the one that does not
exist the way the spec assumed. Read that before planning Phase 1.
