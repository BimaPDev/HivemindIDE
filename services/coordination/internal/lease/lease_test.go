package lease

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func testManager(t *testing.T) (*Manager, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return NewManager(rdb), mr
}

// The Phase 2 demo: two sessions reach for the same file, one wins, the other is
// told who holds it.
func TestContendingSessions(t *testing.T) {
	m, _ := testManager(t)
	ctx := context.Background()

	first, err := m.Request(ctx, "repo-1", "src/billing/charge.go", "session-a", time.Minute, false)
	if err != nil {
		t.Fatalf("first request: %v", err)
	}
	if first.State != StateGranted {
		t.Fatalf("first request state = %q, want granted", first.State)
	}
	if first.Lease == nil || first.Lease.SessionID != "session-a" {
		t.Fatalf("granted result must carry the lease, got %+v", first.Lease)
	}

	second, err := m.Request(ctx, "repo-1", "src/billing/charge.go", "session-b", time.Minute, false)
	if err != nil {
		t.Fatalf("second request: %v", err)
	}
	if second.State != StateDenied {
		t.Fatalf("second request state = %q, want denied", second.State)
	}
	if second.HolderSession != "session-a" {
		t.Errorf("denial must name the holder, got %q", second.HolderSession)
	}
	if second.Lease != nil {
		t.Error("a denied request must not return a lease")
	}
}

func TestDifferentPathsDoNotContend(t *testing.T) {
	m, _ := testManager(t)
	ctx := context.Background()

	a, _ := m.Request(ctx, "repo-1", "src/a.go", "session-a", time.Minute, false)
	b, _ := m.Request(ctx, "repo-1", "src/b.go", "session-b", time.Minute, false)
	if a.State != StateGranted || b.State != StateGranted {
		t.Errorf("independent paths should both be granted, got %q and %q", a.State, b.State)
	}
}

func TestSameRepoIsolationBetweenRepos(t *testing.T) {
	m, _ := testManager(t)
	ctx := context.Background()

	a, _ := m.Request(ctx, "repo-1", "src/a.go", "session-a", time.Minute, false)
	b, _ := m.Request(ctx, "repo-2", "src/a.go", "session-b", time.Minute, false)
	if a.State != StateGranted || b.State != StateGranted {
		t.Errorf("the same path in two repos must not contend, got %q and %q", a.State, b.State)
	}
}

// The fork re-requests on every save, so this has to be cheap and idempotent.
func TestReRequestByHolderRefreshes(t *testing.T) {
	m, mr := testManager(t)
	ctx := context.Background()

	if _, err := m.Request(ctx, "repo-1", "src/a.go", "session-a", 60*time.Second, false); err != nil {
		t.Fatal(err)
	}
	mr.FastForward(40 * time.Second)

	again, err := m.Request(ctx, "repo-1", "src/a.go", "session-a", 60*time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	if again.State != StateGranted {
		t.Fatalf("holder re-request = %q, want granted", again.State)
	}

	_, ttl, err := m.Holder(ctx, "repo-1", "src/a.go")
	if err != nil {
		t.Fatal(err)
	}
	if ttl <= 50*time.Second {
		t.Errorf("TTL = %v, want it refreshed back to ~60s", ttl)
	}
}

func TestLeaseExpiryFreesThePath(t *testing.T) {
	m, mr := testManager(t)
	ctx := context.Background()

	if _, err := m.Request(ctx, "repo-1", "src/a.go", "session-a", 30*time.Second, false); err != nil {
		t.Fatal(err)
	}
	// A crashed editor never releases; the TTL is what unblocks everyone else.
	mr.FastForward(31 * time.Second)

	after, err := m.Request(ctx, "repo-1", "src/a.go", "session-b", time.Minute, false)
	if err != nil {
		t.Fatal(err)
	}
	if after.State != StateGranted {
		t.Errorf("state = %q, want granted after the holder's TTL lapsed", after.State)
	}
}

func TestReleasePromotesTheNextWaiter(t *testing.T) {
	m, _ := testManager(t)
	ctx := context.Background()

	if _, err := m.Request(ctx, "repo-1", "src/a.go", "session-a", time.Minute, false); err != nil {
		t.Fatal(err)
	}
	queued, err := m.Request(ctx, "repo-1", "src/a.go", "session-b", time.Minute, true)
	if err != nil {
		t.Fatal(err)
	}
	if queued.State != StateQueued {
		t.Fatalf("state = %q, want queued", queued.State)
	}
	if queued.Position != 1 {
		t.Errorf("position = %d, want 1", queued.Position)
	}

	released, promoted, err := m.Release(ctx, "repo-1", "src/a.go", "session-a", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !released {
		t.Fatal("holder's release returned false")
	}
	if promoted != "session-b" {
		t.Fatalf("promoted = %q, want session-b", promoted)
	}

	holder, _, err := m.Holder(ctx, "repo-1", "src/a.go")
	if err != nil {
		t.Fatal(err)
	}
	if holder != "session-b" {
		t.Errorf("holder after release = %q, want session-b", holder)
	}
}

// A newcomer must not steal the slot a queued session was waiting for.
func TestPromotionBeatsANewArrival(t *testing.T) {
	m, _ := testManager(t)
	ctx := context.Background()

	_, _ = m.Request(ctx, "repo-1", "src/a.go", "session-a", time.Minute, false)
	_, _ = m.Request(ctx, "repo-1", "src/a.go", "session-b", time.Minute, true)
	_, _, _ = m.Release(ctx, "repo-1", "src/a.go", "session-a", time.Minute)

	newcomer, err := m.Request(ctx, "repo-1", "src/a.go", "session-c", time.Minute, false)
	if err != nil {
		t.Fatal(err)
	}
	if newcomer.State != StateDenied || newcomer.HolderSession != "session-b" {
		t.Errorf("newcomer got %q holder=%q; the queued session should hold it",
			newcomer.State, newcomer.HolderSession)
	}
}

func TestQueueingIsIdempotent(t *testing.T) {
	m, _ := testManager(t)
	ctx := context.Background()

	_, _ = m.Request(ctx, "repo-1", "src/a.go", "session-a", time.Minute, false)
	for i := 0; i < 3; i++ {
		res, err := m.Request(ctx, "repo-1", "src/a.go", "session-b", time.Minute, true)
		if err != nil {
			t.Fatal(err)
		}
		if res.Position != 1 {
			t.Fatalf("retry %d: position = %d, want 1 (no duplicate queue entries)", i, res.Position)
		}
	}
}

func TestReleaseByNonHolderIsNotAnError(t *testing.T) {
	m, _ := testManager(t)
	ctx := context.Background()

	_, _ = m.Request(ctx, "repo-1", "src/a.go", "session-a", time.Minute, false)
	released, promoted, err := m.Release(ctx, "repo-1", "src/a.go", "session-b", time.Minute)
	if err != nil {
		t.Fatalf("release by non-holder errored: %v", err)
	}
	if released {
		t.Error("non-holder release reported success")
	}
	if promoted != "" {
		t.Errorf("non-holder release promoted %q", promoted)
	}

	holder, _, _ := m.Holder(ctx, "repo-1", "src/a.go")
	if holder != "session-a" {
		t.Errorf("holder = %q; a stray release must not steal the lease", holder)
	}
}

// The reason every mutation is a Lua script: check-then-act must be atomic.
func TestConcurrentRequestsProduceExactlyOneWinner(t *testing.T) {
	m, _ := testManager(t)
	ctx := context.Background()

	const contenders = 25
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		granted []string
	)
	start := make(chan struct{})

	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			session := "session-" + string(rune('a'+i))
			<-start
			res, err := m.Request(ctx, "repo-1", "src/hot.go", session, time.Minute, false)
			if err != nil {
				return
			}
			if res.State == StateGranted {
				mu.Lock()
				granted = append(granted, session)
				mu.Unlock()
			}
		}(i)
	}
	close(start)
	wg.Wait()

	if len(granted) != 1 {
		t.Fatalf("%d sessions were granted the same lease: %v", len(granted), granted)
	}
}

func TestListReturnsActiveLeases(t *testing.T) {
	m, _ := testManager(t)
	ctx := context.Background()

	_, _ = m.Request(ctx, "repo-1", "src/a.go", "session-a", time.Minute, false)
	_, _ = m.Request(ctx, "repo-1", "docs/readme.md", "session-b", time.Minute, false)
	_, _ = m.Request(ctx, "repo-2", "src/other.go", "session-c", time.Minute, false)

	leases, err := m.List(ctx, "repo-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(leases) != 2 {
		t.Fatalf("got %d leases for repo-1, want 2: %+v", len(leases), leases)
	}
	for _, l := range leases {
		if l.Path == "" || l.SessionID == "" {
			t.Errorf("incomplete lease in listing: %+v", l)
		}
		if l.ExpiresAt.IsZero() {
			t.Errorf("lease %q has no expiry", l.Path)
		}
	}
}

func TestClampTTL(t *testing.T) {
	cases := map[time.Duration]time.Duration{
		0:                DefaultTTL,
		-5 * time.Second: DefaultTTL,
		time.Second:      MinTTL,
		45 * time.Second: 45 * time.Second,
		3 * time.Hour:    MaxTTL,
	}
	for in, want := range cases {
		if got := ClampTTL(in); got != want {
			t.Errorf("ClampTTL(%v) = %v, want %v", in, got, want)
		}
	}
}
