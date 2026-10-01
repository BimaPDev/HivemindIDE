# Project notes

<!-- Durable knowledge for every AI and teammate working here. HivemindIDE never overwrites this file. -->

## What this project is

## Conventions

## Decisions

- The workbench accent (buttons, badges, active tab, focus, visor) of Hivemind Dynamic/Light comes from `hivemindide.appearance.accentColor` (default Cobalt), applied as a runtime theme overlay. If you change which theme keys carry the accent in `extensions/theme-hivemind/build/generate-themes.py`, update `contrib/hivemindide/common/accentColor.ts` too.

## Gotchas

- Launch the editor with `./fork/run.sh` on macOS and Linux, or `fork\run.cmd` on Windows. Both call `fork/run.mjs`, which scrubs host-editor env vars and selects the Node version in `hivemindide-editor/.nvmrc`. `node_modules` and `.build/electron` are per OS: run `npm install` on that machine; the first launch downloads Electron for it.
- Unit tests in `hivemindide-editor` fail with `Cannot find module 'electron'` when run from a terminal inside VS Code/Cursor: strip the inherited env, e.g. `env -u ELECTRON_RUN_AS_NODE ./scripts/test.sh …` (unset `VSCODE_*` too).
- `scripts/test.sh --grep …` still loads every test file, and upstream `agentHostBootstrap.test` fails to import (`@vscode/copilot-api` was stripped), aborting the run. Select files with `--run src/…/x.test.ts` instead.
- A throwaway demo instance needs a short `--user-data-dir` (e.g. `/tmp/hmn-demo/p`): on macOS the IPC socket path inside it must stay under 103 characters or startup fails with `listen EINVAL`.
