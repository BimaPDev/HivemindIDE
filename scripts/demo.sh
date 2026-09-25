#!/usr/bin/env bash
# Runs both MVP demos against a live stack. Start the services first:
#   docker compose -f deploy/docker-compose.yml up --build -d
#   docker compose -f deploy/docker-compose.yml run --rm seed
set -euo pipefail

PERMISSION="${PERMISSION_URL:-http://127.0.0.1:8081}"
COORDINATION="${COORDINATION_URL:-http://127.0.0.1:8082}"

# Fixed by cmd/seed so this script needs no lookup step.
REPO=11111111-1111-4111-8111-111111111111
SENIOR=22222222-2222-4222-8222-222222222222
CONTRACTOR=33333333-3333-4333-8333-333333333333

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
pretty() { python3 -m json.tool 2>/dev/null || cat; }

post() {
  curl -sS -X POST "$1" -H 'Content-Type: application/json' -d "$2"
}

for url in "$PERMISSION/healthz" "$COORDINATION/healthz"; do
  if ! curl -sSf "$url" >/dev/null 2>&1; then
    echo "not running: $url" >&2
    echo "start the stack with: docker compose -f deploy/docker-compose.yml up -d" >&2
    exit 1
  fi
done

PATHS='["src/billing/charge.go","infra/prod/secrets.tf","infra/staging/db.tf","src/app/.env","docs/architecture.md"]'

bold "PHASE 1 — same repo, same question, two roles"

bold "senior-eng:"
post "$PERMISSION/v1/context/filter" \
  "{\"user_id\":\"$SENIOR\",\"repo_id\":\"$REPO\",\"intent\":\"read\",\"paths\":$PATHS}" | pretty

bold "contractor, identical request:"
post "$PERMISSION/v1/context/filter" \
  "{\"user_id\":\"$CONTRACTOR\",\"repo_id\":\"$REPO\",\"intent\":\"read\",\"paths\":$PATHS}" | pretty

bold "contractor asking to WRITE a file they can only read:"
post "$PERMISSION/v1/context/filter" \
  "{\"user_id\":\"$CONTRACTOR\",\"repo_id\":\"$REPO\",\"intent\":\"write\",\"paths\":[\"docs/architecture.md\"]}" | pretty

bold "PHASE 2 — two sessions reach for the same file"

post "$COORDINATION/v1/presence/heartbeat" \
  "{\"repo_id\":\"$REPO\",\"session_id\":\"sess-bima\",\"user_id\":\"$SENIOR\",\"display_name\":\"Bima\",\"kind\":\"human\",\"current_path\":\"src/billing/charge.go\"}" >/dev/null
post "$COORDINATION/v1/presence/heartbeat" \
  "{\"repo_id\":\"$REPO\",\"session_id\":\"sess-agent\",\"user_id\":\"$CONTRACTOR\",\"display_name\":\"claude-code (Dani)\",\"kind\":\"agent\",\"current_path\":\"src/billing/charge.go\"}" >/dev/null

bold "Bima takes the lease:"
post "$COORDINATION/v1/leases/request" \
  "{\"repo_id\":\"$REPO\",\"session_id\":\"sess-bima\",\"path\":\"src/billing/charge.go\",\"ttl_seconds\":120}" | pretty

bold "the agent tries the same file — blocked, and told by whom:"
post "$COORDINATION/v1/leases/request" \
  "{\"repo_id\":\"$REPO\",\"session_id\":\"sess-agent\",\"path\":\"src/billing/charge.go\",\"ttl_seconds\":120}" | pretty

bold "the agent queues instead:"
post "$COORDINATION/v1/leases/request" \
  "{\"repo_id\":\"$REPO\",\"session_id\":\"sess-agent\",\"path\":\"src/billing/charge.go\",\"ttl_seconds\":120,\"wait\":true}" | pretty

bold "Bima releases — the queued agent is promoted, not the next arrival:"
post "$COORDINATION/v1/leases/release" \
  "{\"repo_id\":\"$REPO\",\"session_id\":\"sess-bima\",\"path\":\"src/billing/charge.go\"}" | pretty

bold "presence feed:"
curl -sS "$COORDINATION/v1/presence/$REPO" | pretty

bold "cleaning up the demo lease"
post "$COORDINATION/v1/leases/release" \
  "{\"repo_id\":\"$REPO\",\"session_id\":\"sess-agent\",\"path\":\"src/billing/charge.go\"}" | pretty
