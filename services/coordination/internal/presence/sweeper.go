package presence

import (
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"time"

	"github.com/redis/go-redis/v9"
)

// keyPattern pulls the repo id and the rest of the key out of, e.g.,
// "hivemindide:{repo-1}:lease:src/a.go".
var keyPattern = regexp.MustCompile(`^hivemindide:\{([^}]+)\}:(lease|presence):(.+)$`)

// Sweeper turns Redis key expiry into stream events.
//
// Redis expires a key silently. Without this, a sidebar panel would keep showing
// a teammate who closed their laptop until something else happened to refresh it.
// Keyspace notifications would be the other way to do this, but they need Redis
// configured a particular way — this works against a stock server.
type Sweeper struct {
	rdb      *redis.Client
	store    *Store
	interval time.Duration
	log      *slog.Logger

	// seen maps a live key to the session that held it on the previous pass.
	seen map[string]string
}

func NewSweeper(rdb *redis.Client, store *Store, interval time.Duration, log *slog.Logger) *Sweeper {
	return &Sweeper{
		rdb:      rdb,
		store:    store,
		interval: interval,
		log:      log,
		seen:     map[string]string{},
	}
}

// Run sweeps until the context is cancelled.
func (s *Sweeper) Run(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	// Prime the map first so the very first sweep does not announce that
	// everything already in Redis has just expired.
	if err := s.sweep(ctx, false); err != nil {
		s.log.Warn("initial presence sweep failed", "err", err)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.sweep(ctx, true); err != nil {
				s.log.Warn("presence sweep failed", "err", err)
			}
		}
	}
}

func (s *Sweeper) sweep(ctx context.Context, emit bool) error {
	current := map[string]string{}

	var cursor uint64
	for {
		keys, next, err := s.rdb.Scan(ctx, cursor, "hivemindide:*", 200).Result()
		if err != nil {
			return err
		}
		for _, k := range keys {
			if !keyPattern.MatchString(k) {
				continue
			}
			val, err := s.rdb.Get(ctx, k).Result()
			if err != nil {
				continue // expired underneath us, or not a string key (a queue list)
			}
			current[k] = val
		}
		if next == 0 {
			break
		}
		cursor = next
	}

	if emit {
		for key, val := range s.seen {
			if _, stillThere := current[key]; stillThere {
				continue
			}
			s.announceExpiry(ctx, key, val)
		}
	}
	s.seen = current
	return nil
}

func (s *Sweeper) announceExpiry(ctx context.Context, key, val string) {
	m := keyPattern.FindStringSubmatch(key)
	if m == nil {
		return
	}
	repoID, kind, rest := m[1], m[2], m[3]

	switch kind {
	case "lease":
		err := s.store.Publish(ctx, repoID, Event{
			Type: EventLeaseExpired,
			Data: map[string]string{"path": rest, "session_id": val},
		})
		if err != nil {
			s.log.Warn("could not announce lease expiry", "err", err, "path", rest)
		}
	case "presence":
		// The stored value is the session JSON; fall back to the id from the key
		// if it will not parse.
		var sess Session
		if json.Unmarshal([]byte(val), &sess) != nil {
			sess = Session{SessionID: rest}
		}
		err := s.store.Publish(ctx, repoID, Event{
			Type: EventPresenceExpired,
			Data: sess,
		})
		if err != nil {
			s.log.Warn("could not announce presence expiry", "err", err, "session", rest)
		}
	}
}
