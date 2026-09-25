# Service API Contract

The one surface both owners share. Owner A builds `permissiond` against it, Owner B
builds `coordinationd` against it, and the fork's TypeScript calls both. Change it by
editing this file and telling the other owner — not by changing a handler and hoping.

Both services speak JSON over HTTP on localhost. No auth between the fork and the
services in the MVP: they bind to `127.0.0.1` and trust the caller. See
[Trust boundary](#trust-boundary) for why that's a deliberate MVP limitation and not
an oversight.

---

## Conventions

- All request and response bodies are `application/json`.
- All timestamps are RFC 3339 UTC.
- IDs are UUIDv4 strings unless noted.
- Paths are **repo-relative, slash-separated, no leading slash**: `src/billing/charge.go`.
  Both services normalize with `path.Clean` and reject absolute paths and `..` segments.
- Errors use a single shape:

```json
{ "error": { "code": "rule_not_found", "message": "no role 'contractor' in repo <id>" } }
```

Error codes are stable strings. HTTP status carries the class (400 / 404 / 409 / 500);
the code carries the specifics.

---

## Permission filter service — `permissiond`

Default port **8081**.

### `POST /v1/context/filter`

The hot path. The fork calls this before any file content reaches the model.

Request:

```json
{
  "user_id": "3f1c...",
  "repo_id": "9ab2...",
  "intent": "read",
  "paths": ["src/billing/charge.go", "infra/prod/secrets.tf"]
}
```

`intent` is `"read"` or `"write"`. A `read` intent is satisfied by a `read` or `write`
rule; a `write` intent requires a `write` rule.

Response `200`:

```json
{
  "allowed": ["src/billing/charge.go"],
  "denied": [
    {
      "path": "infra/prod/secrets.tf",
      "reason": "role 'contractor' has access_level 'none' on this path",
      "matched_rule": { "pattern": "infra/**", "access_level": "none" }
    }
  ]
}
```

`matched_rule` is `null` when nothing matched and the default-deny applied. The fork
shows `reason` verbatim in the UI — it is written to be read by a human, so keep it
that way.

**Ordering is not preserved.** `allowed` and `denied` are each sorted lexically; do not
assume they line up with the request array.

**Empty `paths` returns empty `allowed` and empty `denied`, not an error.**

### `GET /v1/roles/{repo_id}`

Response `200`:

```json
{
  "roles": [
    {
      "id": "c1...",
      "name": "contractor",
      "rules": [
        { "pattern": "src/billing/**", "access_level": "read" },
        { "pattern": "infra/**", "access_level": "none" }
      ]
    }
  ]
}
```

### `POST /v1/roles/{repo_id}`

Creates a role, or replaces an existing role's rule set wholesale (upsert by name).
Rules are **replaced, not merged** — send the full set every time.

```json
{
  "name": "contractor",
  "rules": [
    { "pattern": "src/billing/**", "access_level": "read" }
  ]
}
```

Response `200` with the stored role. `access_level` must be one of `read`, `write`,
`none`; anything else is `400 invalid_access_level`.

### `POST /v1/memberships`

```json
{ "user_id": "3f1c...", "repo_id": "9ab2...", "role_id": "c1..." }
```

Response `200 {"ok": true}`. Idempotent — re-assigning the same triple is not an error.
A user has at most one role per repo; posting a second membership replaces the first.

### `GET /healthz`

`200 {"status":"ok"}` when Postgres is reachable, `503` when it is not.

---

## Pattern matching and precedence

Owner B does not need this, but the fork's UI surfaces its output, so it is contract.

Patterns are globs over repo-relative paths:

| Token | Matches |
|---|---|
| `*` | any run of characters within one path segment |
| `?` | exactly one character within one path segment |
| `**` | zero or more whole path segments |

**A path can match several rules. The winner is the most specific one.** Specificity is
scored per segment, left to right:

- a literal segment (`billing`) scores **4**
- a segment containing `*` or `?` (`*.go`, `charge_?.go`) scores **2**
- a `**` segment scores **0**

Segment scores are summed; ties break on the count of literal (non-wildcard) characters.
If two rules still tie, **the most restrictive level wins** (`none` > `read` > `write`).
That ordering is deliberate: an ambiguous rule set should fail closed.

**If no rule matches, access is denied.** There is no implicit allow. A role that should
see the whole repo needs an explicit `{"pattern": "**", "access_level": "read"}`.

Worked example — role has:

```
**                    → read
infra/**              → none
infra/staging/**      → read
```

| Path | Winner | Why |
|---|---|---|
| `src/main.go` | `**` → read | only match |
| `infra/prod/db.tf` | `infra/**` → none | scores 4, beats `**` at 0 |
| `infra/staging/db.tf` | `infra/staging/**` → read | scores 8, beats `infra/**` at 4 |

---

## Coordination hub — `coordinationd`

Default port **8082**.

### `POST /v1/leases/request`

```json
{
  "repo_id": "9ab2...",
  "session_id": "77de...",
  "path": "src/billing/charge.go",
  "ttl_seconds": 120,
  "wait": false
}
```

`ttl_seconds` is clamped to `[10, 900]`, default 120. `wait: true` enqueues the request
behind the current holder instead of failing fast.

Response `200`, one of three states:

```json
{ "state": "granted", "lease": { "path": "...", "session_id": "...", "expires_at": "..." } }
```

```json
{
  "state": "denied",
  "holder": {
    "session_id": "12ab...",
    "user_id": "...",
    "display_name": "Bima",
    "kind": "agent",
    "current_path": "src/billing/charge.go",
    "expires_at": "2026-09-18T04:12:00Z"
  }
}
```

```json
{ "state": "queued", "position": 1, "holder": { ... } }
```

**Re-requesting a lease you already hold is `granted` and refreshes the TTL.** The fork
calls this on every save, so it must be cheap and idempotent.

### `POST /v1/leases/release`

```json
{ "repo_id": "9ab2...", "session_id": "77de...", "path": "src/billing/charge.go" }
```

Response `200 {"released": true}`. Releasing a lease you do not hold returns
`200 {"released": false}` — **not** an error, because the TTL may have already expired
out from under you and the fork should not treat that as a failure.

If anyone is queued, the next waiter is granted the lease and a `lease.granted` event is
published before this call returns.

### `POST /v1/presence/heartbeat`

Not in the original spec; added because the `presence` store needs a writer.

```json
{
  "repo_id": "9ab2...",
  "session_id": "77de...",
  "user_id": "3f1c...",
  "display_name": "Bima",
  "kind": "human",
  "current_path": "src/billing/charge.go"
}
```

`kind` is `"human"` or `"agent"`. Presence expires 45s after the last heartbeat; the
fork heartbeats every 15s. Response `200 {"ok": true}`.

### `GET /v1/presence/{repo_id}`

```json
{
  "sessions": [ { "session_id": "...", "display_name": "Bima", "kind": "human",
                  "current_path": "src/billing/charge.go", "last_seen": "..." } ],
  "leases":   [ { "path": "src/billing/charge.go", "session_id": "...",
                  "expires_at": "..." } ]
}
```

### `WS /v1/presence/{repo_id}/stream`

The sidebar panel subscribes here. On connect the server sends one `snapshot` frame with
the same body as `GET /v1/presence/{repo_id}`, then deltas. Every frame:

```json
{ "type": "lease.granted", "at": "2026-09-18T04:12:00Z", "data": { ... } }
```

Frame types: `snapshot`, `presence.updated`, `presence.expired`, `lease.granted`,
`lease.denied`, `lease.released`, `lease.expired`.

**Clients must ignore unknown frame types** so either side can add one without a
lockstep release.

Server pings every 30s; a client that misses two pongs is dropped and should reconnect
with backoff.

### `GET /healthz`

`200 {"status":"ok"}` when Redis is reachable, `503` when it is not.

---

## How the two services meet

They do not call each other. The fork calls both.

The one place they touch is the lease-denied path: when the fork is told `denied`, it
shows the holder's `display_name` and `current_path` from `coordinationd` — and those
are **not filtered through `permissiond`**. A contractor who cannot read `infra/**` can
still learn that someone is editing `infra/prod/secrets.tf`, because the presence panel
shows them the path.

That is a real leak and the MVP accepts it knowingly. The fix, when it matters: have the
fork run presence paths through `POST /v1/context/filter` before rendering, and show
denied paths as `a file you don't have access to`. The service contract does not change.

---

## Trust boundary

Both services trust `user_id` and `session_id` as supplied by the caller. There is no
token, no signature, no session validation. Anyone who can reach `127.0.0.1:8081` can
claim to be anyone.

This is fine for the MVP demo and is **not** fine as a security control. Say so in the
README rather than letting a reviewer discover it. Closing it means putting the model
call itself behind `permissiond` so the filter is enforced where the user cannot reach
it — see the v2 note in the root README.

---

## Planned: agent spawn tree + model routing

Not implemented in the MVP services. Shape locked here so the demo page and the native
sidebar can share one tree. Inspired by OmniRoute-style multi-model routing, but scoped
to **who spawned whom** inside a HivemindIDE session — not a full gateway dashboard.

### Node shape

```json
{
  "id": "agent-77de...",
  "kind": "root | agent",
  "author": "Bima",
  "label": "HivemindIDE",
  "model": "sonnet-4",
  "parent_id": null,
  "status": "active | idle | done",
  "spawned_at": "2026-09-18T04:12:00Z"
}
```

- **Root (combined)** — `kind: "root"`. One box for the person who sent the command
  (`author`), the parent AI (`label`), and short `model` name only (`sonnet-4`, `gpt-5`,
  `kimi-k2` — never a provider URL or full ID).
- **Sub-agents** — `kind: "agent"`. Same shape: every node carries **`author`** (whose AI
  this is in a shared IDE), `label`, and `model`. Do not omit `author` on children —
  teammates need to tell agents apart when several people are running at once.
  `parent_id` points at the node that spawned them. Nesting is unbounded.

### Tree response (planned)

```json
{
  "run_id": "run-…",
  "root": {
    "id": "run-root",
    "kind": "root",
    "author": "Bima",
    "label": "HivemindIDE",
    "model": "sonnet-4",
    "status": "active",
    "children": [
      { "id": "agent-a", "kind": "agent", "author": "Bima", "label": "Explore", "model": "haiku", "status": "active", "children": [] },
      { "id": "agent-b", "kind": "agent", "author": "Bima", "label": "Edit",    "model": "sonnet-4", "status": "idle", "children": [] }
    ]
  }
}
```
### Stream frames (planned)

Additive to the existing presence stream. Clients already ignore unknown types:

| Type | When |
|---|---|
| `agent.spawned` | parent creates a child |
| `agent.status` | status or model changes |
| `agent.finished` | node leaves the active tree |

### UI contract

Render as a **graph tree**, not a flat list:

1. One combined root box: author + parent AI + model name.
2. Vertical line → junction **circle** → fan out to each sub-agent box (`label` + model).

Routing inspiration from OmniRoute (combos, fallback, which-model-served) lands later as
optional fields on the agent node (`route`, `fallback_of`). The first ship is the tree.
