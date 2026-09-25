// Package lease implements file leases on top of Redis.
//
// Every state change runs inside a Lua script so that check-then-act is atomic.
// Two editors requesting the same file in the same millisecond is the case this
// service exists to handle, so "GET then SET" would be a bug, not a shortcut.
package lease

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	MinTTL     = 10 * time.Second
	MaxTTL     = 900 * time.Second
	DefaultTTL = 120 * time.Second
)

type State string

const (
	StateGranted State = "granted"
	StateDenied  State = "denied"
	StateQueued  State = "queued"
)

type Lease struct {
	Path      string    `json:"path"`
	SessionID string    `json:"session_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

type Result struct {
	State State
	// HolderSession is set when the request was denied or queued.
	HolderSession string
	// Position is the caller's 1-based place in the queue when queued.
	Position int
	Lease    *Lease
}

type Manager struct {
	rdb *redis.Client
}

func NewManager(rdb *redis.Client) *Manager { return &Manager{rdb: rdb} }

func leaseKey(repoID, path string) string {
	return fmt.Sprintf("hivemindide:{%s}:lease:%s", repoID, path)
}

func queueKey(repoID, path string) string {
	return fmt.Sprintf("hivemindide:{%s}:queue:%s", repoID, path)
}

// ClampTTL keeps a caller-supplied TTL inside the range the contract promises.
func ClampTTL(d time.Duration) time.Duration {
	switch {
	case d <= 0:
		return DefaultTTL
	case d < MinTTL:
		return MinTTL
	case d > MaxTTL:
		return MaxTTL
	}
	return d
}

// acquireScript is the whole contention story in one atomic step:
// free -> grant; already yours -> refresh; held by someone else -> queue or deny.
var acquireScript = redis.NewScript(`
local holder = redis.call('GET', KEYS[1])
if not holder then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return {'granted', ARGV[1], '0'}
end
if holder == ARGV[1] then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return {'granted', holder, '0'}
end
if ARGV[3] == '1' then
  redis.call('LREM', KEYS[2], 0, ARGV[1])
  redis.call('RPUSH', KEYS[2], ARGV[1])
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]) * 4)
  return {'queued', holder, tostring(redis.call('LLEN', KEYS[2]))}
end
return {'denied', holder, '0'}
`)

// releaseScript hands the lease straight to the next waiter rather than deleting
// it, so a queued session cannot be beaten to the free slot by a new arrival.
var releaseScript = redis.NewScript(`
local holder = redis.call('GET', KEYS[1])
if holder ~= ARGV[1] then
  return {'0', ''}
end
local next_session = redis.call('LPOP', KEYS[2])
if next_session then
  redis.call('SET', KEYS[1], next_session, 'EX', ARGV[2])
  return {'1', next_session}
end
redis.call('DEL', KEYS[1])
return {'1', ''}
`)

// Request acquires, refreshes, queues for, or is denied a lease on one path.
func (m *Manager) Request(ctx context.Context, repoID, path, sessionID string, ttl time.Duration, wait bool) (Result, error) {
	ttl = ClampTTL(ttl)
	waitFlag := "0"
	if wait {
		waitFlag = "1"
	}

	raw, err := acquireScript.Run(ctx, m.rdb,
		[]string{leaseKey(repoID, path), queueKey(repoID, path)},
		sessionID, int(ttl.Seconds()), waitFlag).Slice()
	if err != nil {
		return Result{}, fmt.Errorf("acquire: %w", err)
	}
	state, holder, position, err := parseTriple(raw)
	if err != nil {
		return Result{}, err
	}

	res := Result{State: State(state), HolderSession: holder, Position: position}
	if res.State == StateGranted {
		res.HolderSession = sessionID
		res.Lease = &Lease{
			Path:      path,
			SessionID: sessionID,
			ExpiresAt: time.Now().UTC().Add(ttl),
		}
	}
	return res, nil
}

// Release drops a lease the caller holds and promotes the next waiter, if any.
// Releasing a lease you no longer hold is not an error: the TTL may simply have
// expired first, and the editor should not surface that as a failure.
func (m *Manager) Release(ctx context.Context, repoID, path, sessionID string, ttl time.Duration) (released bool, promoted string, err error) {
	raw, err := releaseScript.Run(ctx, m.rdb,
		[]string{leaseKey(repoID, path), queueKey(repoID, path)},
		sessionID, int(ClampTTL(ttl).Seconds())).Slice()
	if err != nil {
		return false, "", fmt.Errorf("release: %w", err)
	}
	if len(raw) != 2 {
		return false, "", errors.New("release: unexpected script reply")
	}
	ok, _ := raw[0].(string)
	promoted, _ = raw[1].(string)
	return ok == "1", promoted, nil
}

// Holder reports the current holder of a path's lease, if any.
func (m *Manager) Holder(ctx context.Context, repoID, path string) (string, time.Duration, error) {
	key := leaseKey(repoID, path)
	session, err := m.rdb.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", 0, nil
	}
	if err != nil {
		return "", 0, fmt.Errorf("holder: %w", err)
	}
	ttl, err := m.rdb.TTL(ctx, key).Result()
	if err != nil {
		return session, 0, nil
	}
	return session, ttl, nil
}

// List returns every active lease in a repo.
//
// This SCANs a key prefix, which is fine at the scale this service targets (one
// repo, a handful of sessions). A deployment with thousands of live leases would
// want a secondary index instead.
func (m *Manager) List(ctx context.Context, repoID string) ([]Lease, error) {
	prefix := fmt.Sprintf("hivemindide:{%s}:lease:", repoID)
	var (
		cursor uint64
		out    = []Lease{}
	)
	for {
		keys, next, err := m.rdb.Scan(ctx, cursor, prefix+"*", 100).Result()
		if err != nil {
			return nil, fmt.Errorf("scan leases: %w", err)
		}
		for _, k := range keys {
			session, err := m.rdb.Get(ctx, k).Result()
			if errors.Is(err, redis.Nil) {
				continue // expired between SCAN and GET
			}
			if err != nil {
				return nil, fmt.Errorf("read lease %s: %w", k, err)
			}
			ttl, _ := m.rdb.TTL(ctx, k).Result()
			out = append(out, Lease{
				Path:      k[len(prefix):],
				SessionID: session,
				ExpiresAt: time.Now().UTC().Add(ttl),
			})
		}
		if next == 0 {
			return out, nil
		}
		cursor = next
	}
}

func parseTriple(raw []any) (state, holder string, position int, err error) {
	if len(raw) != 3 {
		return "", "", 0, fmt.Errorf("unexpected script reply of length %d", len(raw))
	}
	state, _ = raw[0].(string)
	holder, _ = raw[1].(string)
	posStr, _ := raw[2].(string)
	if posStr != "" && posStr != "0" {
		_, _ = fmt.Sscanf(posStr, "%d", &position)
	}
	return state, holder, position, nil
}
