package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/BimaPDev/HivemindIDE/permission/internal/policy"
	"github.com/BimaPDev/HivemindIDE/permission/internal/store"
)

// fakeStore lets the handler tests run without Postgres.
type fakeStore struct {
	roles      map[string]store.Role // keyed by userID
	pingErr    error
	lookupErr  error
	lastUpsert struct{ repoID, name string }
}

func (f *fakeStore) RoleForUser(_ context.Context, userID, _ string) (store.Role, error) {
	if f.lookupErr != nil {
		return store.Role{}, f.lookupErr
	}
	r, ok := f.roles[userID]
	if !ok {
		return store.Role{}, store.ErrNoMembership
	}
	return r, nil
}
func (f *fakeStore) ListRoles(context.Context, string) ([]store.Role, error) { return nil, nil }
func (f *fakeStore) UpsertRole(_ context.Context, repoID, name string, rules []policy.Rule) (store.Role, error) {
	f.lastUpsert.repoID, f.lastUpsert.name = repoID, name
	return store.Role{ID: "role-1", Name: name, Rules: rules}, nil
}
func (f *fakeStore) UpsertMembership(context.Context, string, string, string) error { return nil }
func (f *fakeStore) Ping(context.Context) error                                     { return f.pingErr }

func testServer(f *fakeStore) http.Handler {
	return New(f, slog.New(slog.NewTextHandler(io.Discard, nil))).Routes()
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

// The Phase 1 demo in one test: two users, one repo, one question, two answers.
func TestTwoRolesSameRepoDifferentAnswers(t *testing.T) {
	f := &fakeStore{roles: map[string]store.Role{
		"senior": {ID: "r1", Name: "senior-eng", Rules: []policy.Rule{
			{Pattern: "**", AccessLevel: policy.AccessWrite},
		}},
		"contractor": {ID: "r2", Name: "contractor", Rules: []policy.Rule{
			{Pattern: "**", AccessLevel: policy.AccessRead},
			{Pattern: "infra/**", AccessLevel: policy.AccessNone},
		}},
	}}
	h := testServer(f)

	paths := []string{"src/billing/charge.go", "infra/prod/secrets.tf"}

	var senior filterResponse
	rec := post(t, h, "/v1/context/filter", filterRequest{
		UserID: "senior", RepoID: "repo-1", Intent: "read", Paths: paths})
	if rec.Code != http.StatusOK {
		t.Fatalf("senior: status %d body %s", rec.Code, rec.Body)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &senior); err != nil {
		t.Fatalf("senior decode: %v", err)
	}
	if len(senior.Allowed) != 2 || len(senior.Denied) != 0 {
		t.Errorf("senior-eng should see both paths, got allowed=%v denied=%v",
			senior.Allowed, senior.Denied)
	}

	var contractor filterResponse
	rec = post(t, h, "/v1/context/filter", filterRequest{
		UserID: "contractor", RepoID: "repo-1", Intent: "read", Paths: paths})
	if err := json.Unmarshal(rec.Body.Bytes(), &contractor); err != nil {
		t.Fatalf("contractor decode: %v", err)
	}
	if len(contractor.Allowed) != 1 || contractor.Allowed[0] != "src/billing/charge.go" {
		t.Errorf("contractor allowed = %v, want only the billing file", contractor.Allowed)
	}
	if len(contractor.Denied) != 1 {
		t.Fatalf("contractor denied = %v, want exactly the infra file", contractor.Denied)
	}
	d := contractor.Denied[0]
	if d.Path != "infra/prod/secrets.tf" {
		t.Errorf("denied path = %q", d.Path)
	}
	if d.MatchedRule == nil || d.MatchedRule.Pattern != "infra/**" {
		t.Errorf("denial should name the rule that caused it, got %+v", d.MatchedRule)
	}
	if d.Reason == "" {
		t.Error("denial must carry a reason the UI can show verbatim")
	}
}

func TestNonMemberIsDeniedNotErrored(t *testing.T) {
	h := testServer(&fakeStore{roles: map[string]store.Role{}})
	rec := post(t, h, "/v1/context/filter", filterRequest{
		UserID: "stranger", RepoID: "repo-1", Intent: "read",
		Paths: []string{"src/a.go", "src/b.go"}})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (non-membership is a deny, not an error)", rec.Code)
	}
	var resp filterResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Allowed) != 0 || len(resp.Denied) != 2 {
		t.Errorf("non-member should be denied everything, got %+v", resp)
	}
}

func TestLookupFailureDoesNotLeakPaths(t *testing.T) {
	h := testServer(&fakeStore{lookupErr: context.DeadlineExceeded})
	rec := post(t, h, "/v1/context/filter", filterRequest{
		UserID: "u", RepoID: "r", Intent: "read", Paths: []string{"secret.go"}})
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	// A failed lookup must never come back as an allow.
	if bytes.Contains(rec.Body.Bytes(), []byte("allowed")) {
		t.Errorf("error response contained an allow list: %s", rec.Body)
	}
}

func TestTraversalIsNormalizedBeforeJudging(t *testing.T) {
	f := &fakeStore{roles: map[string]store.Role{
		"u": {Name: "contractor", Rules: []policy.Rule{
			{Pattern: "**", AccessLevel: policy.AccessRead},
			{Pattern: "infra/**", AccessLevel: policy.AccessNone},
		}},
	}}
	rec := post(t, testServer(f), "/v1/context/filter", filterRequest{
		UserID: "u", RepoID: "r", Intent: "read",
		Paths: []string{"src/../infra/prod/secrets.tf"}})
	var resp filterResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Allowed) != 0 {
		t.Errorf("traversal slipped through as allowed: %v", resp.Allowed)
	}
	if len(resp.Denied) != 1 || resp.Denied[0].Path != "infra/prod/secrets.tf" {
		t.Errorf("denied entry should report the normalized path, got %+v", resp.Denied)
	}
}

func TestAbsolutePathIsRejectedNotAllowed(t *testing.T) {
	f := &fakeStore{roles: map[string]store.Role{
		"u": {Name: "eng", Rules: []policy.Rule{{Pattern: "**", AccessLevel: policy.AccessWrite}}},
	}}
	rec := post(t, testServer(f), "/v1/context/filter", filterRequest{
		UserID: "u", RepoID: "r", Intent: "read", Paths: []string{"/etc/passwd"}})
	var resp filterResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Allowed) != 0 {
		t.Errorf("absolute path was allowed by a wide-open role: %v", resp.Allowed)
	}
}

func TestEmptyPathsIsNotAnError(t *testing.T) {
	f := &fakeStore{roles: map[string]store.Role{"u": {Name: "eng"}}}
	rec := post(t, testServer(f), "/v1/context/filter", filterRequest{
		UserID: "u", RepoID: "r", Intent: "read", Paths: nil})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != "{\"allowed\":[],\"denied\":[]}\n" {
		t.Errorf("empty request should return empty arrays, not null: %s", got)
	}
}

func TestInvalidIntentRejected(t *testing.T) {
	h := testServer(&fakeStore{})
	for _, intent := range []string{"", "delete", "READ"} {
		rec := post(t, h, "/v1/context/filter", filterRequest{
			UserID: "u", RepoID: "r", Intent: intent, Paths: []string{"a.go"}})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("intent %q: status = %d, want 400", intent, rec.Code)
		}
	}
}

func TestUpsertRoleValidatesAccessLevel(t *testing.T) {
	h := testServer(&fakeStore{})
	rec := post(t, h, "/v1/roles/repo-1", upsertRoleRequest{
		Name:  "contractor",
		Rules: []policy.Rule{{Pattern: "src/**", AccessLevel: "admin"}},
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("invalid_access_level")) {
		t.Errorf("error code missing from body: %s", rec.Body)
	}
}

func TestHealthReflectsStoreState(t *testing.T) {
	ok := httptest.NewRecorder()
	testServer(&fakeStore{}).ServeHTTP(ok, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if ok.Code != http.StatusOK {
		t.Errorf("healthy store: status = %d", ok.Code)
	}

	down := httptest.NewRecorder()
	testServer(&fakeStore{pingErr: context.DeadlineExceeded}).
		ServeHTTP(down, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if down.Code != http.StatusServiceUnavailable {
		t.Errorf("unreachable store: status = %d, want 503", down.Code)
	}
}
