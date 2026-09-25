package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/BimaPDev/HivemindIDE/coordination/internal/lease"
	"github.com/BimaPDev/HivemindIDE/coordination/internal/presence"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

func testServer(t *testing.T) (http.Handler, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(lease.NewManager(rdb), presence.NewStore(rdb), rdb, log).Routes(), mr
}

func post(t *testing.T, h http.Handler, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	buf, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// The Phase 2 demo end to end over HTTP: B is told who holds the file and what
// they are doing, by name, not by UUID.
func TestDeniedRequestNamesTheHolder(t *testing.T) {
	h, _ := testServer(t)

	if rec := post(t, h, "/v1/presence/heartbeat", heartbeatBody{
		RepoID: "repo-1", SessionID: "sess-a", UserID: "user-a",
		DisplayName: "Bima", Kind: "human", CurrentPath: "src/billing/charge.go",
	}); rec.Code != http.StatusOK {
		t.Fatalf("heartbeat: status %d body %s", rec.Code, rec.Body)
	}

	rec := post(t, h, "/v1/leases/request", leaseRequestBody{
		RepoID: "repo-1", SessionID: "sess-a", Path: "src/billing/charge.go", TTLSeconds: 120,
	})
	var granted leaseResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &granted); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if granted.State != "granted" {
		t.Fatalf("state = %q, want granted", granted.State)
	}

	rec = post(t, h, "/v1/leases/request", leaseRequestBody{
		RepoID: "repo-1", SessionID: "sess-b", Path: "src/billing/charge.go", TTLSeconds: 120,
	})
	var denied leaseResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &denied); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if denied.State != "denied" {
		t.Fatalf("state = %q, want denied", denied.State)
	}
	if denied.Holder == nil {
		t.Fatal("denial carried no holder")
	}
	if denied.Holder.DisplayName != "Bima" {
		t.Errorf("holder display_name = %q, want Bima", denied.Holder.DisplayName)
	}
	if denied.Holder.CurrentPath != "src/billing/charge.go" {
		t.Errorf("holder current_path = %q", denied.Holder.CurrentPath)
	}
	if denied.Holder.ExpiresAt.IsZero() {
		t.Error("denial should tell the caller when the lease frees up")
	}
}

// A holder with no heartbeat still has to produce a usable denial.
func TestDenialWithoutPresenceStillIdentifiesTheSession(t *testing.T) {
	h, _ := testServer(t)
	post(t, h, "/v1/leases/request", leaseRequestBody{
		RepoID: "repo-1", SessionID: "sess-a", Path: "src/a.go", TTLSeconds: 60})

	rec := post(t, h, "/v1/leases/request", leaseRequestBody{
		RepoID: "repo-1", SessionID: "sess-b", Path: "src/a.go", TTLSeconds: 60})
	var denied leaseResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &denied)
	if denied.Holder == nil || denied.Holder.SessionID != "sess-a" {
		t.Fatalf("holder = %+v, want at least the session id", denied.Holder)
	}
}

func TestPathsAreNormalizedToOneKey(t *testing.T) {
	h, _ := testServer(t)

	post(t, h, "/v1/leases/request", leaseRequestBody{
		RepoID: "repo-1", SessionID: "sess-a", Path: "src/billing/charge.go", TTLSeconds: 60})

	// The same file spelled differently must hit the same lease, or the whole
	// mechanism can be walked around by typing "./" in front of the path.
	rec := post(t, h, "/v1/leases/request", leaseRequestBody{
		RepoID: "repo-1", SessionID: "sess-b", Path: "./src/lib/../billing/charge.go", TTLSeconds: 60})
	var resp leaseResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.State != "denied" {
		t.Errorf("state = %q; a differently-spelled path dodged the lease", resp.State)
	}
}

func TestInvalidPathsRejected(t *testing.T) {
	h, _ := testServer(t)
	for _, p := range []string{"", "/etc/passwd", "../outside.go", `src\a.go`} {
		rec := post(t, h, "/v1/leases/request", leaseRequestBody{
			RepoID: "repo-1", SessionID: "s", Path: p, TTLSeconds: 60})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("path %q: status = %d, want 400", p, rec.Code)
		}
	}
}

func TestReleaseOfAnExpiredLeaseIsNotAnError(t *testing.T) {
	h, mr := testServer(t)
	post(t, h, "/v1/leases/request", leaseRequestBody{
		RepoID: "repo-1", SessionID: "sess-a", Path: "src/a.go", TTLSeconds: 30})
	mr.FastForward(31 * time.Second)

	rec := post(t, h, "/v1/leases/release", leaseReleaseBody{
		RepoID: "repo-1", SessionID: "sess-a", Path: "src/a.go"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp map[string]bool
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["released"] {
		t.Error("released = true for a lease that had already expired")
	}
}

func TestHeartbeatValidatesKind(t *testing.T) {
	h, _ := testServer(t)
	for _, k := range []string{"", "robot", "HUMAN"} {
		rec := post(t, h, "/v1/presence/heartbeat", heartbeatBody{
			RepoID: "repo-1", SessionID: "s", Kind: k})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("kind %q: status = %d, want 400", k, rec.Code)
		}
	}
}

func TestHeartbeatAllowsNoOpenFile(t *testing.T) {
	h, _ := testServer(t)
	rec := post(t, h, "/v1/presence/heartbeat", heartbeatBody{
		RepoID: "repo-1", SessionID: "s", Kind: "agent", CurrentPath: ""})
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d; a session with no file open is legitimate", rec.Code)
	}
}

func TestPresenceSnapshotListsSessionsAndLeases(t *testing.T) {
	h, _ := testServer(t)
	post(t, h, "/v1/presence/heartbeat", heartbeatBody{
		RepoID: "repo-1", SessionID: "sess-a", DisplayName: "Bima", Kind: "human",
		CurrentPath: "src/a.go"})
	post(t, h, "/v1/presence/heartbeat", heartbeatBody{
		RepoID: "repo-1", SessionID: "sess-b", DisplayName: "claude-code", Kind: "agent",
		CurrentPath: "src/b.go"})
	post(t, h, "/v1/leases/request", leaseRequestBody{
		RepoID: "repo-1", SessionID: "sess-a", Path: "src/a.go", TTLSeconds: 60})

	rec := get(t, h, "/v1/presence/repo-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body %s", rec.Code, rec.Body)
	}
	var snap presenceSnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(snap.Sessions) != 2 {
		t.Errorf("sessions = %d, want 2: %+v", len(snap.Sessions), snap.Sessions)
	}
	if len(snap.Leases) != 1 || snap.Leases[0].Path != "src/a.go" {
		t.Errorf("leases = %+v, want one on src/a.go", snap.Leases)
	}
}

func TestPresenceExpiresAfterTTL(t *testing.T) {
	h, mr := testServer(t)
	post(t, h, "/v1/presence/heartbeat", heartbeatBody{
		RepoID: "repo-1", SessionID: "sess-a", Kind: "human", CurrentPath: "src/a.go"})

	mr.FastForward(presence.TTL + time.Second)

	var snap presenceSnapshot
	_ = json.Unmarshal(get(t, h, "/v1/presence/repo-1").Body.Bytes(), &snap)
	if len(snap.Sessions) != 0 {
		t.Errorf("a session that stopped heartbeating is still listed: %+v", snap.Sessions)
	}
}

func TestEmptySnapshotSerializesAsArrays(t *testing.T) {
	h, _ := testServer(t)
	body := get(t, h, "/v1/presence/repo-empty").Body.String()
	if strings.Contains(body, "null") {
		t.Errorf("empty snapshot contains null; the panel expects arrays: %s", body)
	}
}

// The sidebar's actual data path: connect, get a snapshot, then see a live event.
func TestWebSocketStreamsSnapshotThenEvents(t *testing.T) {
	h, _ := testServer(t)
	srv := httptest.NewServer(h)
	defer srv.Close()

	post(t, h, "/v1/presence/heartbeat", heartbeatBody{
		RepoID: "repo-1", SessionID: "sess-a", DisplayName: "Bima", Kind: "human",
		CurrentPath: "src/a.go"})

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/presence/repo-1/stream"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))

	var first presence.Event
	if err := conn.ReadJSON(&first); err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if first.Type != presence.EventSnapshot {
		t.Fatalf("first frame type = %q, want snapshot", first.Type)
	}

	// Now cause an event and make sure it arrives on the stream.
	post(t, h, "/v1/leases/request", leaseRequestBody{
		RepoID: "repo-1", SessionID: "sess-a", Path: "src/a.go", TTLSeconds: 60})

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var ev presence.Event
		if err := conn.ReadJSON(&ev); err != nil {
			t.Fatalf("read event: %v", err)
		}
		if ev.Type == presence.EventLeaseGranted {
			return // the panel would now draw a lock on src/a.go
		}
	}
	t.Fatal("never received lease.granted on the stream")
}

func TestStreamIsScopedToItsRepo(t *testing.T) {
	h, _ := testServer(t)
	srv := httptest.NewServer(h)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/presence/repo-1/stream"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	var snap presence.Event
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if err := conn.ReadJSON(&snap); err != nil {
		t.Fatalf("read snapshot: %v", err)
	}

	// Activity in another repo must not appear on this stream.
	post(t, h, "/v1/leases/request", leaseRequestBody{
		RepoID: "repo-2", SessionID: "sess-x", Path: "src/other.go", TTLSeconds: 60})

	_ = conn.SetReadDeadline(time.Now().Add(700 * time.Millisecond))
	var leaked presence.Event
	if err := conn.ReadJSON(&leaked); err == nil {
		t.Fatalf("repo-1 stream received an event from repo-2: %+v", leaked)
	}
}

func TestHealthReflectsRedisState(t *testing.T) {
	h, mr := testServer(t)
	if rec := get(t, h, "/healthz"); rec.Code != http.StatusOK {
		t.Errorf("healthy: status = %d", rec.Code)
	}
	mr.Close()
	if rec := get(t, h, "/healthz"); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("redis down: status = %d, want 503", rec.Code)
	}
}
