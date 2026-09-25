// Package api serves the coordination hub HTTP and WebSocket surface described
// in contract/README.md.
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/BimaPDev/HivemindIDE/coordination/internal/lease"
	"github.com/BimaPDev/HivemindIDE/coordination/internal/presence"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/redis/go-redis/v9"
)

type Server struct {
	leases   *lease.Manager
	presence *presence.Store
	rdb      *redis.Client
	log      *slog.Logger
}

func New(l *lease.Manager, p *presence.Store, rdb *redis.Client, log *slog.Logger) *Server {
	return &Server{leases: l, presence: p, rdb: rdb, log: log}
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.Recoverer, corsForDemoPage)

	r.Get("/healthz", s.handleHealth)
	r.Route("/v1", func(r chi.Router) {
		r.Post("/leases/request", s.handleLeaseRequest)
		r.Post("/leases/release", s.handleLeaseRelease)
		r.Post("/presence/heartbeat", s.handleHeartbeat)
		r.Get("/presence/{repo_id}", s.handlePresence)
		r.Get("/presence/{repo_id}/stream", s.handleStream)
	})
	return r
}

// corsForDemoPage lets demo/index.html talk to the hub when it is opened from
// the filesystem. The service is localhost-only, so this widens nothing that was
// not already reachable by anything running on the machine.
func corsForDemoPage(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- plumbing ------------------------------------------------------------

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

// normalizePath mirrors the permission service's rule so a lease key and a
// permission decision always refer to the same string.
func normalizePath(p string) (string, bool) {
	if p == "" || strings.HasPrefix(p, "/") || strings.ContainsRune(p, '\\') {
		return "", false
	}
	clean := path.Clean(p)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return clean, true
}

// --- handlers ------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.rdb.Ping(r.Context()).Err(); err != nil {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]string{"status": "degraded", "detail": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

type leaseRequestBody struct {
	RepoID     string `json:"repo_id"`
	SessionID  string `json:"session_id"`
	Path       string `json:"path"`
	TTLSeconds int    `json:"ttl_seconds"`
	Wait       bool   `json:"wait"`
}

type holderView struct {
	SessionID   string    `json:"session_id"`
	UserID      string    `json:"user_id,omitempty"`
	DisplayName string    `json:"display_name,omitempty"`
	Kind        string    `json:"kind,omitempty"`
	CurrentPath string    `json:"current_path,omitempty"`
	ExpiresAt   time.Time `json:"expires_at,omitempty"`
}

type leaseResponse struct {
	State    string       `json:"state"`
	Lease    *lease.Lease `json:"lease,omitempty"`
	Holder   *holderView  `json:"holder,omitempty"`
	Position int          `json:"position,omitempty"`
}

func (s *Server) handleLeaseRequest(w http.ResponseWriter, r *http.Request) {
	var req leaseRequestBody
	if !decode(w, r, &req) {
		return
	}
	if req.RepoID == "" || req.SessionID == "" {
		writeErr(w, http.StatusBadRequest, "missing_field", "repo_id and session_id are required")
		return
	}
	norm, ok := normalizePath(req.Path)
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid_path",
			"path must be repo-relative, forward-slashed and inside the repo")
		return
	}

	ttl := lease.ClampTTL(time.Duration(req.TTLSeconds) * time.Second)
	res, err := s.leases.Request(r.Context(), req.RepoID, norm, req.SessionID, ttl, req.Wait)
	if err != nil {
		s.log.Error("lease request failed", "err", err, "path", norm)
		writeErr(w, http.StatusInternalServerError, "lease_failed", "could not evaluate the lease")
		return
	}

	resp := leaseResponse{State: string(res.State), Position: res.Position}
	switch res.State {
	case lease.StateGranted:
		resp.Lease = res.Lease
		s.publish(r, req.RepoID, presence.EventLeaseGranted, res.Lease)
	default:
		holder := s.describeHolder(r, req.RepoID, norm, res.HolderSession)
		resp.Holder = &holder
		if res.State == lease.StateDenied {
			s.publish(r, req.RepoID, presence.EventLeaseDenied, map[string]any{
				"path":         norm,
				"requested_by": req.SessionID,
				"held_by":      res.HolderSession,
			})
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// describeHolder joins the raw session id from the lease store onto whatever the
// presence store knows about that session, so a denial can say "Bima is editing
// this" instead of printing a UUID at the user.
func (s *Server) describeHolder(r *http.Request, repoID, path, sessionID string) holderView {
	h := holderView{SessionID: sessionID}
	if sess, ok, err := s.presence.Get(r.Context(), repoID, sessionID); err == nil && ok {
		h.UserID = sess.UserID
		h.DisplayName = sess.DisplayName
		h.Kind = string(sess.Kind)
		h.CurrentPath = sess.CurrentPath
	}
	if _, ttl, err := s.leases.Holder(r.Context(), repoID, path); err == nil && ttl > 0 {
		h.ExpiresAt = time.Now().UTC().Add(ttl)
	}
	return h
}

type leaseReleaseBody struct {
	RepoID    string `json:"repo_id"`
	SessionID string `json:"session_id"`
	Path      string `json:"path"`
}

func (s *Server) handleLeaseRelease(w http.ResponseWriter, r *http.Request) {
	var req leaseReleaseBody
	if !decode(w, r, &req) {
		return
	}
	if req.RepoID == "" || req.SessionID == "" {
		writeErr(w, http.StatusBadRequest, "missing_field", "repo_id and session_id are required")
		return
	}
	norm, ok := normalizePath(req.Path)
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid_path", "path must be repo-relative")
		return
	}

	released, promoted, err := s.leases.Release(r.Context(), req.RepoID, norm, req.SessionID, lease.DefaultTTL)
	if err != nil {
		s.log.Error("lease release failed", "err", err, "path", norm)
		writeErr(w, http.StatusInternalServerError, "release_failed", "could not release the lease")
		return
	}

	if released {
		s.publish(r, req.RepoID, presence.EventLeaseReleased, map[string]string{
			"path": norm, "session_id": req.SessionID,
		})
		if promoted != "" {
			s.publish(r, req.RepoID, presence.EventLeaseGranted, lease.Lease{
				Path:      norm,
				SessionID: promoted,
				ExpiresAt: time.Now().UTC().Add(lease.DefaultTTL),
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"released": released})
}

type heartbeatBody struct {
	RepoID      string `json:"repo_id"`
	SessionID   string `json:"session_id"`
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	Kind        string `json:"kind"`
	CurrentPath string `json:"current_path"`
}

func (s *Server) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	var req heartbeatBody
	if !decode(w, r, &req) {
		return
	}
	if req.RepoID == "" || req.SessionID == "" {
		writeErr(w, http.StatusBadRequest, "missing_field", "repo_id and session_id are required")
		return
	}
	kind := presence.Kind(req.Kind)
	if !kind.Valid() {
		writeErr(w, http.StatusBadRequest, "invalid_kind", `kind must be "human" or "agent"`)
		return
	}
	// An empty current_path is legitimate — the session has no file open.
	norm := ""
	if req.CurrentPath != "" {
		var ok bool
		if norm, ok = normalizePath(req.CurrentPath); !ok {
			writeErr(w, http.StatusBadRequest, "invalid_path", "current_path must be repo-relative")
			return
		}
	}

	err := s.presence.Heartbeat(r.Context(), req.RepoID, presence.Session{
		SessionID:   req.SessionID,
		UserID:      req.UserID,
		DisplayName: req.DisplayName,
		Kind:        kind,
		CurrentPath: norm,
	})
	if err != nil {
		s.log.Error("heartbeat failed", "err", err, "session", req.SessionID)
		writeErr(w, http.StatusInternalServerError, "write_failed", "could not record presence")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type presenceSnapshot struct {
	Sessions []presence.Session `json:"sessions"`
	Leases   []lease.Lease      `json:"leases"`
}

func (s *Server) handlePresence(w http.ResponseWriter, r *http.Request) {
	snap, err := s.snapshot(r, chi.URLParam(r, "repo_id"))
	if err != nil {
		s.log.Error("presence snapshot failed", "err", err)
		writeErr(w, http.StatusInternalServerError, "lookup_failed", "could not read presence")
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) snapshot(r *http.Request, repoID string) (presenceSnapshot, error) {
	sessions, err := s.presence.List(r.Context(), repoID)
	if err != nil {
		return presenceSnapshot{}, err
	}
	leases, err := s.leases.List(r.Context(), repoID)
	if err != nil {
		return presenceSnapshot{}, err
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].SessionID < sessions[j].SessionID })
	sort.Slice(leases, func(i, j int) bool { return leases[i].Path < leases[j].Path })
	return presenceSnapshot{Sessions: sessions, Leases: leases}, nil
}

func (s *Server) publish(r *http.Request, repoID, evType string, data any) {
	if err := s.presence.Publish(r.Context(), repoID, presence.Event{Type: evType, Data: data}); err != nil {
		s.log.Warn("could not publish event", "err", err, "type", evType)
	}
}
