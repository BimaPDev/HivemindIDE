package presence

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func testSweeper(t *testing.T) (*Sweeper, *Store, *redis.Client, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	store := NewStore(rdb)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewSweeper(rdb, store, time.Second, log), store, rdb, mr
}

// A teammate closes their laptop. Redis expires the key silently, so without the
// sweeper the sidebar would keep showing them indefinitely.
func TestSweeperAnnouncesPresenceExpiry(t *testing.T) {
	sw, store, rdb, mr := testSweeper(t)
	ctx := context.Background()

	if err := store.Heartbeat(ctx, "repo-1", Session{
		SessionID: "sess-a", DisplayName: "Bima", Kind: KindHuman, CurrentPath: "src/a.go",
	}); err != nil {
		t.Fatal(err)
	}

	sub := rdb.Subscribe(ctx, channel("repo-1"))
	defer sub.Close()
	if _, err := sub.Receive(ctx); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	msgs := sub.Channel()

	// Prime, then let the key lapse, then sweep for real.
	if err := sw.sweep(ctx, false); err != nil {
		t.Fatal(err)
	}
	mr.FastForward(TTL + time.Second)
	if err := sw.sweep(ctx, true); err != nil {
		t.Fatal(err)
	}

	select {
	case msg := <-msgs:
		var ev Event
		if err := json.Unmarshal([]byte(msg.Payload), &ev); err != nil {
			t.Fatalf("decode event: %v", err)
		}
		if ev.Type != EventPresenceExpired {
			t.Fatalf("event type = %q, want %q", ev.Type, EventPresenceExpired)
		}
		data, _ := json.Marshal(ev.Data)
		var sess Session
		_ = json.Unmarshal(data, &sess)
		if sess.SessionID != "sess-a" {
			t.Errorf("expiry event named session %q", sess.SessionID)
		}
		if sess.DisplayName != "Bima" {
			t.Errorf("expiry event lost the display name: %+v", sess)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no presence.expired event published")
	}
}

// The first sweep must not announce that everything already in Redis has expired.
func TestSweeperDoesNotAnnounceOnPriming(t *testing.T) {
	sw, store, rdb, _ := testSweeper(t)
	ctx := context.Background()

	if err := store.Heartbeat(ctx, "repo-1", Session{
		SessionID: "sess-a", Kind: KindHuman}); err != nil {
		t.Fatal(err)
	}

	sub := rdb.Subscribe(ctx, channel("repo-1"))
	defer sub.Close()
	if _, err := sub.Receive(ctx); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	msgs := sub.Channel()

	if err := sw.sweep(ctx, false); err != nil {
		t.Fatal(err)
	}

	select {
	case msg := <-msgs:
		t.Fatalf("priming sweep published an event: %s", msg.Payload)
	case <-time.After(500 * time.Millisecond):
	}
}

func TestSweeperIgnoresStillLiveKeys(t *testing.T) {
	sw, store, rdb, _ := testSweeper(t)
	ctx := context.Background()

	if err := store.Heartbeat(ctx, "repo-1", Session{SessionID: "sess-a", Kind: KindHuman}); err != nil {
		t.Fatal(err)
	}

	sub := rdb.Subscribe(ctx, channel("repo-1"))
	defer sub.Close()
	if _, err := sub.Receive(ctx); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	msgs := sub.Channel()

	_ = sw.sweep(ctx, false)
	_ = sw.sweep(ctx, true) // nothing has expired in between

	select {
	case msg := <-msgs:
		t.Fatalf("sweeper announced an expiry for a live session: %s", msg.Payload)
	case <-time.After(500 * time.Millisecond):
	}
}

func TestKeyPatternParsesRepoAndKind(t *testing.T) {
	cases := map[string][3]string{
		"hivemindide:{repo-1}:lease:src/a.go":       {"repo-1", "lease", "src/a.go"},
		"hivemindide:{repo-1}:presence:sess-a":      {"repo-1", "presence", "sess-a"},
		"hivemindide:{9ab2-cd}:lease:a/b/c/deep.go": {"9ab2-cd", "lease", "a/b/c/deep.go"},
	}
	for key, want := range cases {
		m := keyPattern.FindStringSubmatch(key)
		if m == nil {
			t.Errorf("%s did not parse", key)
			continue
		}
		if m[1] != want[0] || m[2] != want[1] || m[3] != want[2] {
			t.Errorf("%s parsed as %v, want %v", key, m[1:], want)
		}
	}

	// Queue keys are lists, not leases, and must not be mistaken for one.
	if keyPattern.MatchString("hivemindide:{repo-1}:queue:src/a.go") {
		t.Error("queue key matched the lease/presence pattern")
	}
}
