# Project notes

<!-- Durable knowledge for every AI and teammate working here. HivemindIDE never overwrites this file. -->

## What this project is

## Conventions

## Decisions

## Gotchas

- Launch the editor with `./fork/run.sh` on macOS and Linux, or `fork\run.cmd` on Windows. Both call `fork/run.mjs`, which scrubs host-editor env vars and selects the Node version in `hivemindide-editor/.nvmrc`. `node_modules` and `.build/electron` are per OS: run `npm install` on that machine; the first launch downloads Electron for it.
- Unit tests in `hivemindide-editor` fail with `Cannot find module 'electron'` when run from a terminal inside VS Code/Cursor: strip the inherited env, e.g. `env -u ELECTRON_RUN_AS_NODE ./scripts/test.sh …` (unset `VSCODE_*` too).
- `scripts/test.sh --grep …` still loads every test file, and upstream `agentHostBootstrap.test` fails to import (`@vscode/copilot-api` was stripped), aborting the run. Select files with `--run src/…/x.test.ts` instead.
