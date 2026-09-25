# HivemindIDE

A fork of VS Code — `microsoft/vscode` directly, the way Cursor is — with two
things built into the editor core rather than bolted on as an extension:

1. **Permission-scoped AI context** — the AI panel's context requests are
   filtered against the user's actual role before they leave the client.
2. **File leasing and presence** — two teammates or agents cannot silently
   destroy each other's in-progress work in the same file.

This repo holds the two Go services behind those features and the API contract
between them. The editor itself is a sibling repository, `../hivemindide-editor` —
see [fork/README.md](fork/README.md) for why it is not a subdirectory.

## What works today

| | Status |
|---|---|
| API contract between the services | Written, [contract/README.md](contract/README.md) |
| `permissiond` — roles, path rules, context filtering | Built, tested, runs |
| `coordinationd` — leases, presence, event stream | Built, tested, runs |
| Postgres + Redis + compose stack | Runs |
| Status page showing both features live | Runs |
| Agent spawn tree (author+AI root → sub-agents) | Native sidebar in the editor fork; demo until live `agent.*` frames |
| Fork integration clients (TypeScript) | Written and typechecked, not yet in a fork |
| **The editor fork** | Cloned, branded, compiles and runs — see [fork/](fork/) |

**Coming next (OmniRoute-inspired).** Multi-model routing transparency — which model
served a turn, fallback chains — sits on the same agent tree nodes. The spawn tree UI
ships first; the gateway/routing layer is a later service, not a clone of OmniRoute.

Phases 1 and 2 as described in the spec are the *editor-side* work. The services
they call are finished; the editor they call from is not.

## Run it

```bash
./fork/run.sh   # launch the editor from source
```

```bash
make up      # postgres, redis, permissiond, coordinationd
make seed    # demo repo, two users, two roles
make demo    # both MVP demos, end to end
make page    # the status page
```

Without Docker, point the services at a local Postgres and Redis:

```bash
export PERMISSION_DATABASE_URL="postgres://hivemindide:hivemindide@127.0.0.1:5432/hivemindide_dev?sslmode=disable"
cd services/permission   && go run ./cmd/seed && go run ./cmd/permissiond &
cd services/coordination && COORDINATION_REDIS_ADDR=127.0.0.1:6379 go run ./cmd/coordinationd &
./scripts/demo.sh
```

`make test` runs every test without any services running — the suites use
`miniredis` and an in-memory store.

## What the demo shows

**Phase 1.** Two users ask for the same six files in the same repo. `senior-eng`
gets all six. `contractor` gets four, and is told why the other two were
withheld and which rule did it — including that `infra/staging/**` beats the
broader `infra/**` deny, because the more specific rule wins.

**Phase 2.** Two sessions reach for `src/billing/charge.go`. One is granted the
lease. The other is denied and told *Bima (human) is editing this, their lease
expires in 118s* — then queues, and is promoted the moment Bima releases, ahead
of any session that arrives in between.

## Layout

```
contract/     the API contract — the one surface both owners share
services/
  permission/     Go + chi + Postgres. Roles, path rules, context filtering.
  coordination/   Go + chi + Redis. Leases, presence, WebSocket stream.
fork/
  apply-branding.sh  turns a vscode checkout into HivemindIDE (brand + strip Microsoft/telemetry)
  integration/       TypeScript that goes inside the fork, and where it hooks in
deploy/       docker-compose
demo/         status page — the MVP stand-in for the native sidebar
scripts/      demo.sh
```

## Deviations from the spec

Three, all deliberate:

**No RabbitMQ.** Nothing in the MVP consumed `lease_events`, and Redis pub/sub
already carries presence to the sidebar. A third datastore in compose was ops
cost with no demo value. The event types are unchanged, so moving them onto a
real queue later is a change inside `internal/presence`, not a contract change.

**No MCP.** It was in the spec's tech-stack table but nowhere in its
architecture, and it argues against the fork: if the permission filter is
reachable over MCP, Claude Code and Codex get the feature without the editor. It
is a good v2 story — "the same service also fronts external agents" — but it is
not MVP.

**No region leases.** `region_hash` assumes a region is stable, and any edit
above it shifts the lines and invalidates the hash. Leases are per-file.

Added, because the spec's data model had no writer for it:
`POST /v1/presence/heartbeat`.

## Known limitations

These are written down rather than left to be discovered:

**The filter is advisory, not a security control.** It runs client-side in the
fork, and both services trust whatever `user_id` their caller claims. Anyone who
can reach `127.0.0.1:8081` can be anyone. Closing this means putting the model
call itself behind `permissiond` so the filter sits where the user cannot reach
it — the same Go service, one more endpoint. Worth doing before anyone calls
this a security feature.

**The filter's unit is file paths.** Real agent context also includes grep
results, symbol lookups, terminal output and git history. A path filter that
only sees file opens leaks a restricted tree through one `git log -p`. The demo
is scoped to file-read context on purpose.

**Presence paths are not filtered.** A contractor who cannot read `infra/**` can
still see that someone is editing `infra/prod/secrets.tf`. The fix is about an
hour of work and is described in [contract/README.md](contract/README.md).

**The lease hook only covers editor saves.** An agent writing through
`fs.writeFile` never triggers a save participant. See
[fork/integration/README.md](fork/integration/README.md).

**Microsoft's extensions will be missing.** Pylance, the Remote pack and the
C/C++ toolchain are not on Open VSX and cannot legally ship in a non-Microsoft
product. Forking vscode directly rather than VSCodium does not change this — the
marketplace terms are about the product, not the base.

**The fork is a maintenance commitment.** Upstream moves weekly. Keeping core
changes in new files under `src/vs/workbench/contrib/hivemindide/` is what keeps
merges cheap; editing existing files is what makes them expensive.

## Team split

- **Owner A** — `services/permission` and the Phase 0 fork build.
- **Owner B** — `services/coordination` and the native sidebar panel.

The services do not call each other; the fork calls both. The only shared
surface is [contract/README.md](contract/README.md). Change it by editing that
file and telling the other owner.
