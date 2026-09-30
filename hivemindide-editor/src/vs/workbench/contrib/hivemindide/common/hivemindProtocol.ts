/*---------------------------------------------------------------------------------------------
 *  HivemindIDE hivemind: the on-disk protocol.
 *
 *  `.hivemind/` is plain Markdown so any AI tool can read and write it without
 *  an SDK. The README written here is the contract those tools follow; the
 *  IDE's own parser (hivemindService.ts) must accept everything it describes.
 *
 *  One file per node, and no shared index file: several people (and their AIs)
 *  write at once and share the folder through git, and separate files merge
 *  cleanly where a single graph.json would conflict on every pull.
 *--------------------------------------------------------------------------------------------*/

export const HIVEMIND_FOLDER = '.hivemind';
export const HIVEMIND_NODES_FOLDER = 'nodes';
export const HIVEMIND_PROTOCOL_VERSION = 1;

export const HIVEMIND_POINTER_START = '<!-- hivemind:start -->';
export const HIVEMIND_POINTER_END = '<!-- hivemind:end -->';

/** Instruction files other AI tools read on their own; each gets the pointer block. */
export const HIVEMIND_POINTER_FILES = ['AGENTS.md', 'CLAUDE.md'];

export type HivemindNodeStatus = 'active' | 'paused' | 'done';

export const HIVEMIND_README = `<!-- Managed by HivemindIDE (hivemind protocol ${HIVEMIND_PROTOCOL_VERSION}). Rewritten when the protocol changes; put project knowledge in project.md. -->
# .hivemind

Shared memory for the people and AIs working on this project. Any AI — HivemindIDE's own, Claude Code, Codex, Cursor, Copilot — reads it before starting and records its work here when it stops, so the next one can pick up where it left off.

## Layout

- \`project.md\`: durable knowledge: what the project is, conventions, decisions, gotchas. Edit it when you learn something the next AI should know.
- \`nodes/<id>.md\`: one file per unit of work (a chat, an agent run, a task). Nodes form a graph through \`parent\`.

## Before you start

1. Read \`project.md\`.
2. List \`nodes/\` and read the most recently \`updated\` nodes, especially any \`active\` or \`paused\` ones related to your task.
3. If you are continuing a node, read it fully and start from its **Handoff**.

## When you work

Create **your own** node file. To continue someone else's node, create a new node with \`parent:\` set to theirs. Do not edit another author's node except to set its \`status\` to \`done\` once your child node finishes the work.

File name: \`nodes/<id>.md\`, where \`<id>\` is \`YYYYMMDD-HHMM-short-slug-xxxx\` (UTC time, a few words, 4 random letters or digits).

\`\`\`markdown
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
\`\`\`

Rules:

- Front matter uses the keys above; values stay on one line. \`parent\` and \`model\` are optional. Tools may add their own keys (HivemindIDE adds \`chatSession\`): keep any key you do not recognise.
- \`status\` is \`active\` (being worked on), \`paused\` (stopped part-way; the Handoff says how to resume) or \`done\`.
- Update \`updated\` and the Handoff every time you stop. Append to Log; never rewrite earlier entries.
- Never put secrets, tokens or credentials in \`.hivemind\`. It is shared with everyone on the project.
`;

export const HIVEMIND_PROJECT_TEMPLATE = `# Project notes

<!-- Durable knowledge for every AI and teammate working here. HivemindIDE never overwrites this file. -->

## What this project is

## Conventions

## Decisions

## Gotchas
`;

export const HIVEMIND_POINTER_BLOCK = `${HIVEMIND_POINTER_START}
## Hivemind (shared AI context)

This project keeps shared context for people and AIs in \`.hivemind/\`. Before you start, read \`.hivemind/README.md\`, then \`.hivemind/project.md\` and the most recently updated nodes in \`.hivemind/nodes/\`. When you stop, record your work as a node exactly as \`.hivemind/README.md\` describes, so the next AI can pick up where you left off.
${HIVEMIND_POINTER_END}`;
