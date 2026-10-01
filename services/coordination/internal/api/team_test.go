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

	"github.com/BimaPDev/HivemindIDE/coordination/internal/lease"
	"github.com/BimaPDev/HivemindIDE/coordination/internal/presence"
	"github.com/alicebob/miniredis/v2"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

func call(t *testing.T, h http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		buf, _ := json.Marshal(body)
		reader = bytes.NewReader(buf)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func signIn(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body)
	}
	var out signedIn
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out.Token
}

// A repo that nobody has made a team for works exactly as before.
func TestOpenRepoNeedsNoToken(t *testing.T) {
	h, _ := testServer(t)
	if rec := call(t, h, http.MethodGet, "/v1/presence/open-repo", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("open repo: %d", rec.Code)
	}
}

func TestTeamGatesTheRepoAndTakesIdentityFromTheToken(t *testing.T) {
	h, _ := testServer(t)
	alice := signIn(t, call(t, h, http.MethodPost, "/v1/teams/r", "", map[string]string{"user_id": "alice", "display_name": "Alice"}))

	// From now on, the repo needs a member's token.
	if rec := call(t, h, http.MethodGet, "/v1/presence/r", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", rec.Code)
	}
	if rec := call(t, h, http.MethodGet, "/v1/presence/r", "hvt_forged", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("forged token: %d", rec.Code)
	}
	// A heartbeat claiming to be someone else is recorded as the token's owner.
	call(t, h, http.MethodPost, "/v1/presence/heartbeat", alice, map[string]string{"repo_id": "r", "session_id": "s1", "user_id": "mallory", "display_name": "Mallory", "kind": "human"})
	rec := call(t, h, http.MethodGet, "/v1/presence/r", alice, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"user_id":"alice"`) || strings.Contains(rec.Body.String(), "mallory") {
		t.Fatalf("identity must come from the token: %s", rec.Body)
	}
	// Leases too.
	if rec := call(t, h, http.MethodPost, "/v1/leases/request", "", map[string]any{"repo_id": "r", "session_id": "s1", "path": "a.go", "ttl_seconds": 60}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("lease without token: %d", rec.Code)
	}
}

func TestOnlyOwnersAndAdminsShare(t *testing.T) {
	h, _ := testServer(t)
	alice := signIn(t, call(t, h, http.MethodPost, "/v1/teams/r", "", map[string]string{"user_id": "alice"}))

	invite := func(token, role string) (int, string) {
		rec := call(t, h, http.MethodPost, "/v1/teams/r/invites", token, map[string]any{"role": role, "max_uses": 1})
		var out inviteView
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out.Code
	}
	status, memberCode := invite(alice, "member")
	if status != http.StatusCreated {
		t.Fatalf("owner invites: %d", status)
	}
	bob := signIn(t, call(t, h, http.MethodPost, "/v1/teams/r/join", "", map[string]string{"code": memberCode, "user_id": "bob"}))

	// Bob is a member: he can see the team but not share it, and does not see invites.
	if status, _ := invite(bob, "member"); status != http.StatusForbidden {
		t.Fatalf("a member must not invite: %d", status)
	}
	view := call(t, h, http.MethodGet, "/v1/teams/r", bob, nil)
	if view.Code != http.StatusOK || strings.Contains(view.Body.String(), `"invites"`) {
		t.Fatalf("member's view: %d %s", view.Code, view.Body)
	}
	// Alice makes Bob an admin; now he can share.
	if rec := call(t, h, http.MethodPatch, "/v1/teams/r/members/bob", alice, map[string]string{"role": "admin"}); rec.Code != http.StatusOK {
		t.Fatalf("promote: %d %s", rec.Code, rec.Body)
	}
	status, chenCode := invite(bob, "member")
	if status != http.StatusCreated {
		t.Fatalf("an admin invites: %d", status)
	}
	chen := signIn(t, call(t, h, http.MethodPost, "/v1/teams/r/join", "", map[string]string{"code": chenCode, "user_id": "chen"}))

	// Bob removes Chen; Chen is out at once.
	if rec := call(t, h, http.MethodDelete, "/v1/teams/r/members/chen", bob, nil); rec.Code != http.StatusOK {
		t.Fatalf("admin removes member: %d", rec.Code)
	}
	if rec := call(t, h, http.MethodGet, "/v1/presence/r", chen, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("removed member still reads presence: %d", rec.Code)
	}
	// Nobody removes the owner.
	if rec := call(t, h, http.MethodDelete, "/v1/teams/r/members/alice", bob, nil); rec.Code != http.StatusConflict {
		t.Fatalf("removing the owner: %d", rec.Code)
	}
}

func TestSetupSecretGuardsTeamCreation(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	h := New(lease.NewManager(rdb), presence.NewStore(rdb), rdb, slog.New(slog.NewTextHandler(io.Discard, nil))).WithTeamSetupSecret("s3cret").Routes()

	if rec := call(t, h, http.MethodPost, "/v1/teams/r", "", map[string]string{"user_id": "mallory"}); rec.Code != http.StatusForbidden {
		t.Fatalf("create without the secret: %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/teams/r", strings.NewReader(`{"user_id":"alice"}`))
	req.Header.Set("X-Hivemind-Setup-Secret", "s3cret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create with the secret: %d %s", rec.Code, rec.Body)
	}
}

// Browsers open WebSockets without headers, so the stream takes the token as a parameter.
func TestStreamNeedsAMembersToken(t *testing.T) {
	h, _ := testServer(t)
	alice := signIn(t, call(t, h, http.MethodPost, "/v1/teams/r", "", map[string]string{"user_id": "alice"}))
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	base := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/presence/r/stream"

	if _, resp, err := websocket.DefaultDialer.Dial(base, nil); err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("stream without token should be refused with 401, got %v", resp)
	}
	conn, _, err := websocket.DefaultDialer.Dial(base+"?access_token="+alice, nil)
	if err != nil {
		t.Fatalf("stream with token: %v", err)
	}
	defer conn.Close()
	var frame map[string]any
	if err := conn.ReadJSON(&frame); err != nil || frame["type"] != "snapshot" {
		t.Fatalf("first frame: %v %v", err, frame)
	}
}

// Found by the stress test: a removed member's open stream kept receiving the team's events.
func TestStreamClosesWhenItsMemberIsRemoved(t *testing.T) {
	h, _ := testServer(t)
	alice := signIn(t, call(t, h, http.MethodPost, "/v1/teams/r", "", map[string]string{"user_id": "alice"}))
	var inv inviteView
	_ = json.Unmarshal(call(t, h, http.MethodPost, "/v1/teams/r/invites", alice, map[string]any{"role": "member"}).Body.Bytes(), &inv)
	bob := signIn(t, call(t, h, http.MethodPost, "/v1/teams/r/join", "", map[string]string{"code": inv.Code, "user_id": "bob"}))

	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/v1/presence/r/stream?access_token="+bob, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var frame map[string]any
	_ = conn.ReadJSON(&frame) // snapshot

	call(t, h, http.MethodDelete, "/v1/teams/r/members/bob", alice, nil)
	call(t, h, http.MethodPost, "/v1/presence/heartbeat", alice, map[string]string{"repo_id": "r", "session_id": "a1", "kind": "human", "current_path": "secret.md"})
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := conn.ReadMessage()
	if !websocket.IsCloseError(err, closeLostAccess) {
		t.Fatalf("stream should close with %d, got %v (message %s)", closeLostAccess, err, msg)
	}
}

// And a stream watching an open repo closes once the repo gets a team.
func TestAnonymousStreamClosesWhenATeamIsCreated(t *testing.T) {
	h, _ := testServer(t)
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/v1/presence/r/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var frame map[string]any
	_ = conn.ReadJSON(&frame) // snapshot
	signIn(t, call(t, h, http.MethodPost, "/v1/teams/r", "", map[string]string{"user_id": "alice"}))
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); !websocket.IsCloseError(err, closeLostAccess) {
		t.Fatalf("stream should close with %d, got %v", closeLostAccess, err)
	}
}

func TestMembersCannotUseEachOthersSessions(t *testing.T) {
	h, _ := testServer(t)
	alice := signIn(t, call(t, h, http.MethodPost, "/v1/teams/r", "", map[string]string{"user_id": "alice"}))
	var inv inviteView
	_ = json.Unmarshal(call(t, h, http.MethodPost, "/v1/teams/r/invites", alice, map[string]any{"role": "member"}).Body.Bytes(), &inv)
	bob := signIn(t, call(t, h, http.MethodPost, "/v1/teams/r/join", "", map[string]string{"code": inv.Code, "user_id": "bob"}))

	call(t, h, http.MethodPost, "/v1/presence/heartbeat", alice, map[string]string{"repo_id": "r", "session_id": "a1", "kind": "human"})
	call(t, h, http.MethodPost, "/v1/leases/request", alice, map[string]any{"repo_id": "r", "session_id": "a1", "path": "main.go"})
	for _, rec := range []*httptest.ResponseRecorder{
		call(t, h, http.MethodPost, "/v1/presence/heartbeat", bob, map[string]string{"repo_id": "r", "session_id": "a1", "kind": "human"}),
		call(t, h, http.MethodPost, "/v1/leases/release", bob, map[string]any{"repo_id": "r", "session_id": "a1", "path": "main.go"}),
		call(t, h, http.MethodPost, "/v1/leases/request", bob, map[string]any{"repo_id": "r", "session_id": "a1", "path": "other.go"}),
	} {
		if rec.Code != http.StatusForbidden {
			t.Fatalf("bob using alice's session: want 403, got %d %s", rec.Code, rec.Body)
		}
	}
}

func TestOversizedAndInvalidInput(t *testing.T) {
	h, _ := testServer(t)
	big := bytes.Repeat([]byte("a"), 1<<20)
	req := httptest.NewRequest(http.MethodPost, "/v1/teams/r", bytes.NewReader(append(append([]byte(`{"user_id":"`), big...), '"', '}')))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("1 MB body: want 413, got %d", rec.Code)
	}
	for _, body := range []map[string]string{{"user_id": "a b"}, {"user_id": "   "}, {"user_id": "ok", "display_name": strings.Repeat("N", 500)}} {
		if rec := call(t, h, http.MethodPost, "/v1/teams/r", "", body); rec.Code != http.StatusBadRequest {
			t.Fatalf("%v: want 400, got %d", body, rec.Code)
		}
	}
	alice := signIn(t, call(t, h, http.MethodPost, "/v1/teams/r", "", map[string]string{"user_id": "alice"}))
	var inv inviteView
	_ = json.Unmarshal(call(t, h, http.MethodPost, "/v1/teams/r/invites", alice, map[string]any{"role": "member", "ttl_hours": 1 << 40}).Body.Bytes(), &inv)
	if ttl := time.Until(inv.Invite.ExpiresAt); ttl <= 29*24*time.Hour || ttl > maxInviteTTL {
		t.Fatalf("a huge ttl should clamp to 30 days, got %s", ttl)
	}
}

// ?only=team spares a client that only tracks the team from all presence traffic.
func TestTeamOnlyStreamSkipsPresence(t *testing.T) {
	h, _ := testServer(t)
	alice := signIn(t, call(t, h, http.MethodPost, "/v1/teams/r", "", map[string]string{"user_id": "alice"}))
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/v1/presence/r/stream?only=team&access_token="+alice, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var frame map[string]any
	_ = conn.ReadJSON(&frame) // snapshot
	call(t, h, http.MethodPost, "/v1/presence/heartbeat", alice, map[string]string{"repo_id": "r", "session_id": "a1", "kind": "human"})
	call(t, h, http.MethodPost, "/v1/teams/r/invites", alice, map[string]any{"role": "member"})
	var inv inviteView
	_ = json.Unmarshal(call(t, h, http.MethodPost, "/v1/teams/r/invites", alice, map[string]any{"role": "member"}).Body.Bytes(), &inv)
	call(t, h, http.MethodPost, "/v1/teams/r/join", "", map[string]string{"code": inv.Code, "user_id": "bob"})
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if err := conn.ReadJSON(&frame); err != nil || frame["type"] != "team.member_joined" {
		t.Fatalf("first event should be the join, got %v %v", err, frame)
	}
}
