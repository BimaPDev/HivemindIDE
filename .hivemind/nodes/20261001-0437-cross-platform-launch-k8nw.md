---
id: 20261001-0437-cross-platform-launch-k8nw
title: Launch the editor on Windows and Linux
parent:
status: done
author: Bima
agent: Cursor
model: composer
created: 2026-10-01T04:37:00Z
updated: 2026-10-01T04:56:00Z
---

## Goal
Make the from-source editor launch work on Windows and Linux, not only macOS.

## Handoff
Done and pushed to `origin/main`. `./fork/run.sh` (macOS, Linux) and `fork\run.cmd` (Windows) both start `fork/run.mjs`, which picks the Node version in `hivemindide-editor/.nvmrc` and runs `scripts/code.sh` or `scripts/code.bat`. Verified here with `node --test fork/launch.test.mjs` (12 passing) and `./fork/run.sh --dry-run` (resolves Node v24.18.0 and `scripts/code.sh`). Not launched on a Windows or Linux machine.

## Files
- fork/run.mjs
- fork/launch.mjs
- fork/launch.test.mjs
- fork/ensure-out.mjs
- fork/run.sh
- fork/run.cmd
- fork/run.ps1
- fork/node-bin.sh
- fork/ensure-out.sh
- README.md
- fork/README.md
- Makefile

## Log
### 2026-10-01 04:37 · Bima
Asked to run this on Windows and Linux. The launch path was `./fork/run.sh` (bash, nvm under `$HOME`). Replaced the env scrub, Node lookup, and `out/` heal with a Node launcher shared by bash and PowerShell, and pointed `make page` at `xdg-open` on Linux.

### 2026-10-01 04:56 · Bima
Asked to push everything still uncommitted. Split into three commits (team and editor UI, the cross-platform launcher, docs and `.hivemind`) and pushed to `origin/main`.
