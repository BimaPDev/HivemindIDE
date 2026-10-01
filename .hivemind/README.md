<!-- Managed by HivemindIDE (hivemind protocol 1). Rewritten when the protocol changes; put project knowledge in project.md. -->
# .hivemind

Shared memory for the people and AIs working on this project. Any AI — HivemindIDE's own, Claude Code, Codex, Cursor, Copilot — reads it before starting and records its work here when it stops, so the next one can pick up where it left off.

## Layout

- `project.md`: durable knowledge: what the project is, conventions, decisions, gotchas. Edit it when you learn something the next AI should know.
- `nodes/<id>.md`: one file per unit of work (a chat, an agent run, a task). Nodes form a graph through `parent`.

## Before you start

1. Read `project.md`.
2. List `nodes/` and read the most recently `updated` nodes, especially any `active` or `paused` ones related to your task.
3. If you are continuing a node, read it fully and start from its **Handoff**.

## When you work

Create **your own** node file. To continue someone else's node, create a new node with `parent:` set to theirs. Do not edit another author's node except to set its `status` to `done` once your child node finishes the work.

File name: `nodes/<id>.md`, where `<id>` is `YYYYMMDD-HHMM-short-slug-xxxx` (UTC time, a few words, 4 random letters or digits).

```markdown
---
id: 20260925-0215-lease-queue-fix-k3v9
title: Fix lease queue promotion order
parent: 20260924-1730-lease-audit-p2d1
status: active
author: Bima
agent: Claude Code
model: sonnet-4
created: 2026-09-25T02:15:00Z
updated: 2026-09-25T02:40:00Z
---

## Goal
What this node is trying to achieve, in a sentence or two.

## Handoff
Where the work stands right now and the very next step. Written for a reader
with no other context. Keep it current: overwrite it, do not append to it.

## Files
- services/coordination/internal/lease/lease.go

## Log
### 2026-09-25 02:15 · Bima
What was asked, what was done or answered, what was decided.
```

Rules:

- Front matter uses the keys above; values stay on one line. `parent` and `model` are optional. Tools may add their own keys (HivemindIDE adds `chatSession`): keep any key you do not recognise.
- `status` is `active` (being worked on), `paused` (stopped part-way; the Handoff says how to resume) or `done`.
- Update `updated` and the Handoff every time you stop. Append to Log; never rewrite earlier entries.
- Never put secrets, tokens or credentials in `.hivemind`. It is shared with everyone on the project.
