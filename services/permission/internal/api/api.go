// Package api serves the permission filter HTTP surface described in
// contract/README.md.
package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sort"

	"github.com/BimaPDev/HivemindIDE/permission/internal/policy"
	"github.com/BimaPDev/HivemindIDE/permission/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type Server struct {
	store store.Store
	log   *slog.Logger
}

func New(s store.Store, log *slog.Logger) *Server {
	return &Server{store: s, log: log}
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.Recoverer)

	r.Get("/healthz", s.handleHealth)
	r.Route("/v1", func(r chi.Router) {
		r.Post("/context/filter", s.handleFilter)
		r.Get("/roles/{repo_id}", s.handleListRoles)
		r.Post("/roles/{repo_id}", s.handleUpsertRole)
		r.Post("/memberships", s.handleUpsertMembership)
	})
	return r
}

// --- error plumbing ------------------------------------------------------

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]apiError{"error": {Code: code, Message: msg}})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_body", err.Error())
		return false
	}
	return true
}

// --- handlers ------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]string{"status": "degraded", "detail": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

type filterRequest struct {
	UserID string   `json:"user_id"`
	RepoID string   `json:"repo_id"`
	Intent string   `json:"intent"`
	Paths  []string `json:"paths"`
}

type deniedPath struct {
	Path        string       `json:"path"`
	Reason      string       `json:"reason"`
	MatchedRule *policy.Rule `json:"matched_rule"`
}

type filterResponse struct {
	Allowed []string     `json:"allowed"`
	Denied  []deniedPath `json:"denied"`
}

// handleFilter is the hot path: the fork calls it before file content reaches
// the model. It never returns a partial result — either every path is judged or
// the whole request fails, so the caller can't accidentally ship an unjudged path.
func (s *Server) handleFilter(w http.ResponseWriter, r *http.Request) {
	var req filterRequest
	if !decode(w, r, &req) {
		return
	}
	if req.UserID == "" || req.RepoID == "" {
		writeErr(w, http.StatusBadRequest, "missing_field", "user_id and repo_id are required")
		return
	}
	intent := policy.Intent(req.Intent)
	if !intent.Valid() {
		writeErr(w, http.StatusBadRequest, "invalid_intent", `intent must be "read" or "write"`)
		return
	}

	resp := filterResponse{Allowed: []string{}, Denied: []deniedPath{}}
	if len(req.Paths) == 0 {
		writeJSON(w, http.StatusOK, resp)
		return
	}

	role, err := s.store.RoleForUser(r.Context(), req.UserID, req.RepoID)
	switch {
	case errors.Is(err, store.ErrNoMembership):
		// Not an error: a non-member simply sees nothing. Denying explicitly
		// here keeps the fork's UI on one code path.
		for _, p := range req.Paths {
			resp.Denied = append(resp.Denied, deniedPath{
				Path:   p,
				Reason: "you have no role in this repository",
			})
		}
		sortDenied(resp.Denied)
		writeJSON(w, http.StatusOK, resp)
		return
	case err != nil:
		s.log.Error("role lookup failed", "err", err, "user_id", req.UserID, "repo_id", req.RepoID)
		writeErr(w, http.StatusInternalServerError, "lookup_failed", "could not resolve the user's role")
		return
	}

	for _, raw := range req.Paths {
		norm, err := policy.NormalizePath(raw)
		if err != nil {
			// A path we can't normalize is a path we can't judge, so it is denied.
			resp.Denied = append(resp.Denied, deniedPath{Path: raw, Reason: err.Error()})
			continue
		}
		d := policy.Evaluate(role.Name, role.Rules, norm, intent)
		if d.Allowed {
			resp.Allowed = append(resp.Allowed, norm)
			continue
		}
		resp.Denied = append(resp.Denied, deniedPath{
			Path:        norm,
			Reason:      d.Reason,
			MatchedRule: d.Rule,
		})
	}

	sort.Strings(resp.Allowed)
	sortDenied(resp.Denied)
	writeJSON(w, http.StatusOK, resp)
}

func sortDenied(d []deniedPath) {
	sort.Slice(d, func(i, j int) bool { return d[i].Path < d[j].Path })
}

func (s *Server) handleListRoles(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repo_id")
	roles, err := s.store.ListRoles(r.Context(), repoID)
	if errors.Is(err, store.ErrRepoNotFound) {
		writeErr(w, http.StatusNotFound, "repo_not_found", "no repo with id "+repoID)
		return
	}
	if err != nil {
		s.log.Error("list roles failed", "err", err, "repo_id", repoID)
		writeErr(w, http.StatusInternalServerError, "lookup_failed", "could not list roles")
		return
	}
	writeJSON(w, http.StatusOK, map[string][]store.Role{"roles": roles})
}

type upsertRoleRequest struct {
	Name  string        `json:"name"`
	Rules []policy.Rule `json:"rules"`
}

func (s *Server) handleUpsertRole(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repo_id")
	var req upsertRoleRequest
	if !decode(w, r, &req) {
		return
	}
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "missing_field", "name is required")
		return
	}
	for _, rule := range req.Rules {
		if !rule.AccessLevel.Valid() {
			writeErr(w, http.StatusBadRequest, "invalid_access_level",
				"access_level must be read, write or none; got "+string(rule.AccessLevel))
			return
		}
		if rule.Pattern == "" {
			writeErr(w, http.StatusBadRequest, "invalid_pattern", "pattern must not be empty")
			return
		}
	}

	role, err := s.store.UpsertRole(r.Context(), repoID, req.Name, req.Rules)
	if errors.Is(err, store.ErrRepoNotFound) {
		writeErr(w, http.StatusNotFound, "repo_not_found", "no repo with id "+repoID)
		return
	}
	if err != nil {
		s.log.Error("upsert role failed", "err", err, "repo_id", repoID, "role", req.Name)
		writeErr(w, http.StatusInternalServerError, "write_failed", "could not save the role")
		return
	}
	writeJSON(w, http.StatusOK, role)
}

type membershipRequest struct {
	UserID string `json:"user_id"`
	RepoID string `json:"repo_id"`
	RoleID string `json:"role_id"`
}

func (s *Server) handleUpsertMembership(w http.ResponseWriter, r *http.Request) {
	var req membershipRequest
	if !decode(w, r, &req) {
		return
	}
	if req.UserID == "" || req.RepoID == "" || req.RoleID == "" {
		writeErr(w, http.StatusBadRequest, "missing_field",
			"user_id, repo_id and role_id are required")
		return
	}
	if err := s.store.UpsertMembership(r.Context(), req.UserID, req.RepoID, req.RoleID); err != nil {
		s.log.Error("upsert membership failed", "err", err)
		writeErr(w, http.StatusInternalServerError, "write_failed", "could not save the membership")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
