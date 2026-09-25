# Fork integration

The TypeScript that goes inside the VSCodium fork. It is written and typechecked
here so it isn't blocked on Phase 0 finishing — drop it into the checkout once
the build is green.

Drop target for both clients:
`src/vs/workbench/services/hivemindide/common/`

Nothing here imports from `vscode` (the extension API) on purpose. These are
workbench services in the fork's core, which is the whole point of forking
rather than shipping an extension.

---

## Phase 1: where the permission filter goes

**Read this before you plan the sprint.** VSCodium has no built-in AI panel to
intercept. Code-OSS ships the chat *UI* (`src/vs/workbench/contrib/chat`), but
the language-model provider and the agent loop live in the GitHub Copilot Chat
extension, which is licensed to Microsoft products and was pulled from Open VSX.
Installing it into the fork is not a path.

So Phase 1 is not "intercept the existing panel". It is one of:

1. **Register your own language-model provider and chat participant** against
   the chat UI that is already there, BYO-key to Anthropic or OpenAI. The
   context-assembly code is then yours, and `failClosed()` goes directly in
   front of the file reads it does. Most defensible version, largest chunk of
   work in the project — budget more than the spec's 2–3 weeks.
2. **Vendor Copilot Chat's MIT source into the fork** and patch its context
   assembly. Faster to a demo, but it is a second fork to maintain, of a
   codebase that moves faster than VS Code core.

Whichever you pick, put it in the README. A reviewer who knows this ecosystem
will ask, and "we built the provider" is a much better answer than a vague one.

### Call shape

Always `failClosed`, never `client.filter` directly:

```ts
const result = await failClosed(permissionClient, userId, repoId, candidatePaths);
for (const path of result.allowed) { /* read it, send it to the model */ }
for (const d of result.denied)     { /* show d.reason in the panel, verbatim */ }
```

Showing the denials rather than silently dropping them is what makes the demo
land. "I can't see infra/prod/secrets.tf because your role is contractor" reads
as a product; a short answer with no explanation reads as a broken one.

### What this does *not* cover

The filter's unit is file paths. An agent's context is not only file paths — it
is also grep results, symbol lookups, diagnostics, terminal output and git
history. A path filter that only sees file opens leaks the entire restricted
tree through one `git log -p` in the integrated terminal.

For the MVP, scope the demo to file-read context and **say so out loud**. Doing
that quietly while claiming a security boundary is the one thing here that would
actively damage the portfolio story.

---

## Phase 2: where the lease check goes

This one has a real seam in the fork's core. `ITextFileSaveParticipant` is the
mechanism format-on-save already uses: async, ordered, and able to block a save.

See `src/vs/workbench/contrib/codeEditor/browser/saveParticipants.ts` for the
pattern to copy, and register alongside those.

```ts
class LeaseSaveParticipant implements ITextFileSaveParticipant {
	async participate(model: ITextFileEditorModel, context, progress, token): Promise<void> {
		const path = this.repoRelative(model.resource);
		const res = await this.coordination.requestLease(this.repoId, this.sessionId, path);
		if (res.state !== 'granted') {
			// Throwing here aborts the save. The message is what the user sees.
			throw new Error(describeDenial(res, path));
		}
	}
}
```

Three things to design around now rather than discover later:

**Save participants share one time budget.** Exhaust it and later participants
are skipped. The lease check must be fast, and you must decide deliberately what
a timeout means. Fail closed (block the save) is the honest choice given this is
sold as enforcement — but it makes a dead service feel like a broken editor, so
put the service URL in settings and make the failure message say which service
is down.

**It only covers editor saves.** An agent writing through `fs.writeFile`, or
anything editing the file from a terminal, never fires this. If the demo is
"two agents fight over a file" and one of them is Claude Code writing to disk
directly, this hook does not fire at all. Either make the demo
teammate-vs-teammate, or have agents go through an MCP tool that takes the lease
first. Pick one and build the demo around it.

**Renew, don't re-acquire.** `requestLease` by the current holder refreshes the
TTL and is cheap — that is why the contract makes it idempotent. Call it on
every save without special-casing.

### Presence

Heartbeat every `HEARTBEAT_INTERVAL_MS` (15s) with the active editor's path;
the server expires a session at 45s, so two missed beats are tolerated. Point
the sidebar panel at `streamUrl(repoId)` and re-render on every frame, ignoring
frame types you don't recognise — the contract guarantees new ones can appear
without a lockstep release.

**Agents spawn tree (shipped).** Native sidebar under the HivemindIDE activity-bar
icon (`contrib/hivemindide/browser/agentTree*`). One combined root box: author +
parent AI + model name; edges fan out to sub-agents. Demo trees render until
coordinationd emits `agent.tree` / `agent.spawned`. Settings:
`hivemindide.agentTree.*`.

### One known leak

Presence paths are **not** run through the permission filter. A contractor who
cannot read `infra/**` can still see that someone is editing
`infra/prod/secrets.tf`, because the panel prints the path.

The fix is to run presence paths through `failClosed` before rendering and show
denied ones as "a file you don't have access to". It is maybe an hour of work.
It is not done, and the MVP accepts it knowingly — but it is written down in
`contract/README.md` rather than left for someone to find.
