// Package presence tracks who is in which file, and carries the event stream the
// fork's sidebar panel subscribes to.
package presence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// TTL is how long a session stays visible after its last heartbeat. The fork
// heartbeats every 15s, so this tolerates two missed beats before a session
// disappears from the panel.
const TTL = 45 * time.Second

type Kind string

const (
	KindHuman Kind = "human"
	KindAgent Kind = "agent"
)

func (k Kind) Valid() bool { return k == KindHuman || k == KindAgent }

type Session struct {
	SessionID   string    `json:"session_id"`
	UserID      string    `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Kind        Kind      `json:"kind"`
	CurrentPath string    `json:"current_path"`
	LastSeen    time.Time `json:"last_seen"`
}

// Event is one frame on the WebSocket stream.
type Event struct {
	Type string    `json:"type"`
	At   time.Time `json:"at"`
	Data any       `json:"data,omitempty"`
}

const (
	EventSnapshot        = "snapshot"
	EventPresenceUpdated = "presence.updated"
	EventPresenceExpired = "presence.expired"
	EventLeaseGranted    = "lease.granted"
	EventLeaseDenied     = "lease.denied"
	EventLeaseReleased   = "lease.released"
	EventLeaseExpired    = "lease.expired"
)

type Store struct {
	rdb *redis.Client
}

func NewStore(rdb *redis.Client) *Store { return &Store{rdb: rdb} }

func sessionKey(repoID, sessionID string) string {
	return fmt.Sprintf("hivemindide:{%s}:presence:%s", repoID, sessionID)
}

func channel(repoID string) string {
	return fmt.Sprintf("hivemindide:{%s}:events", repoID)
}

// Heartbeat records or refreshes a session's presence.
func (s *Store) Heartbeat(ctx context.Context, repoID string, sess Session) error {
	sess.LastSeen = time.Now().UTC()
	body, err := json.Marshal(sess)
	if err != nil {
		return fmt.Errorf("marshal session: %w", err)
	}
	if err := s.rdb.Set(ctx, sessionKey(repoID, sess.SessionID), body, TTL).Err(); err != nil {
		return fmt.Errorf("write presence: %w", err)
	}
	return s.Publish(ctx, repoID, Event{
		Type: EventPresenceUpdated,
		At:   sess.LastSeen,
		Data: sess,
	})
}

// List returns every session currently visible in a repo.
func (s *Store) List(ctx context.Context, repoID string) ([]Session, error) {
	prefix := fmt.Sprintf("hivemindide:{%s}:presence:", repoID)
	var (
		cursor uint64
		out    = []Session{}
	)
	for {
		keys, next, err := s.rdb.Scan(ctx, cursor, prefix+"*", 100).Result()
		if err != nil {
			return nil, fmt.Errorf("scan presence: %w", err)
		}
		for _, k := range keys {
			body, err := s.rdb.Get(ctx, k).Bytes()
			if errors.Is(err, redis.Nil) {
				continue // expired between SCAN and GET
			}
			if err != nil {
				return nil, fmt.Errorf("read presence %s: %w", k, err)
			}
			var sess Session
			if err := json.Unmarshal(body, &sess); err != nil {
				// A malformed entry should not blank out the whole panel.
				continue
			}
			out = append(out, sess)
		}
		if next == 0 {
			return out, nil
		}
		cursor = next
	}
}

// Get returns one session, or ok=false if it has expired.
func (s *Store) Get(ctx context.Context, repoID, sessionID string) (Session, bool, error) {
	body, err := s.rdb.Get(ctx, sessionKey(repoID, sessionID)).Bytes()
	if errors.Is(err, redis.Nil) {
		return Session{}, false, nil
	}
	if err != nil {
		return Session{}, false, fmt.Errorf("read presence: %w", err)
	}
	var sess Session
	if err := json.Unmarshal(body, &sess); err != nil {
		return Session{}, false, fmt.Errorf("decode presence: %w", err)
	}
	return sess, true, nil
}

// Publish broadcasts an event to every subscriber of a repo's stream.
func (s *Store) Publish(ctx context.Context, repoID string, ev Event) error {
	if ev.At.IsZero() {
		ev.At = time.Now().UTC()
	}
	body, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}
	if err := s.rdb.Publish(ctx, channel(repoID), body).Err(); err != nil {
		return fmt.Errorf("publish %s: %w", ev.Type, err)
	}
	return nil
}

// Subscribe returns a channel of raw event payloads for a repo. The caller closes
// the returned PubSub to stop.
func (s *Store) Subscribe(ctx context.Context, repoID string) (*redis.PubSub, <-chan *redis.Message) {
	ps := s.rdb.Subscribe(ctx, channel(repoID))
	return ps, ps.Channel()
}
