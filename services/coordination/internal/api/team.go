package api

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/BimaPDev/HivemindIDE/coordination/internal/team"
	"github.com/go-chi/chi/v5"
)

// Invites last a week unless the inviter says otherwise, and never more than 30 days.
const (
	defaultInviteTTL = 7 * 24 * time.Hour
	maxInviteTTL     = 30 * 24 * time.Hour
)

// WithTeamSetupSecret requires `secret` to create a team, so whoever can reach
// the hub cannot claim a repo before its real owner does. Empty leaves creation open.
func (s *Server) WithTeamSetupSecret(secret string) *Server {
	s.setupSecret = secret
	return s
}

func (s *Server) teamRoutes(r chi.Router) {
	r.Post("/teams/{repo_id}", s.handleCreateTeam)
	r.Get("/teams/{repo_id}", s.handleGetTeam)
	r.Post("/teams/{repo_id}/join", s.handleJoinTeam)
	r.Post("/teams/{repo_id}/invites", s.handleCreateInvite)
	r.Delete("/teams/{repo_id}/invites/{invite_id}", s.handleRevokeInvite)
	r.Patch("/teams/{repo_id}/members/{user_id}", s.handleSetRole)
	r.Delete("/teams/{repo_id}/members/{user_id}", s.handleRemoveMember)
	r.Post("/teams/{repo_id}/transfer", s.handleTransfer)
}

// bearer: the caller's token, from the Authorization header, or for WebSockets
// (which browsers open without custom headers) the access_token query parameter.
func bearer(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	}
	return r.URL.Query().Get("access_token")
}

// authorize gates every call about a repo. A repo with no team stays open (open
// is true, no member). Otherwise the caller must present a member's token; the
// response is written and ok is false when they do not.
func (s *Server) authorize(w http.ResponseWriter, r *http.Request, repoID string) (member team.Member, open bool, ok bool) {
	exists, err := s.teams.Exists(r.Context(), repoID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "lookup_failed", "could not check the repo's team")
		return team.Member{}, false, false
	}
	if !exists {
		return team.Member{}, true, true
	}
	m, err := s.teams.Authenticate(r.Context(), repoID, bearer(r))
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "this repo has a team: sign in with a member's token")
		return team.Member{}, false, false
	}
	return m, false, true
}

// authorizeSession is authorize for calls made as one editor session. On a team
// repo the session must be the caller's own: the first member to use a session
// id keeps it, so nobody can heartbeat as someone else's session or release
// their leases.
func (s *Server) authorizeSession(w http.ResponseWriter, r *http.Request, repoID, sessionID string) bool {
	me, open, ok := s.authorize(w, r, repoID)
	if !ok {
		return false
	}
	return open || s.claimSession(w, r, repoID, sessionID, me)
}

func (s *Server) claimSession(w http.ResponseWriter, r *http.Request, repoID, sessionID string, me team.Member) bool {
	mine, err := s.teams.ClaimSession(r.Context(), repoID, sessionID, me.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "lookup_failed", "could not check who the session belongs to")
		return false
	}
	if !mine {
		writeErr(w, http.StatusForbidden, "not_your_session", "that session belongs to another member")
		return false
	}
	return true
}

// member is authorize for team calls, which need a member even to read.
func (s *Server) member(w http.ResponseWriter, r *http.Request) (team.Member, string, bool) {
	repoID := chi.URLParam(r, "repo_id")
	m, open, ok := s.authorize(w, r, repoID)
	if ok && open {
		writeErr(w, http.StatusNotFound, "no_team", team.ErrNoTeam.Error())
		return team.Member{}, repoID, false
	}
	return m, repoID, ok
}

func (s *Server) teamErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, team.ErrForbidden):
		writeErr(w, http.StatusForbidden, "forbidden", err.Error())
	case errors.Is(err, team.ErrTeamExists), errors.Is(err, team.ErrAlreadyMember), errors.Is(err, team.ErrOwnerMustStay):
		writeErr(w, http.StatusConflict, "conflict", err.Error())
	case errors.Is(err, team.ErrInvalidInvite):
		writeErr(w, http.StatusForbidden, "invalid_invite", err.Error())
	case errors.Is(err, team.ErrNotMember), errors.Is(err, team.ErrNoTeam):
		writeErr(w, http.StatusNotFound, "not_found", err.Error())
	default:
		s.log.Error("team call failed", "err", err)
		writeErr(w, http.StatusInternalServerError, "team_failed", "could not complete the team change")
	}
}

type identityBody struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
}

type signedIn struct {
	Member team.Member `json:"member"`
	// Token is shown once: the client keeps it, the hub keeps only its hash.
	Token string `json:"token"`
}

func (s *Server) handleCreateTeam(w http.ResponseWriter, r *http.Request) {
	if s.setupSecret != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Hivemind-Setup-Secret")), []byte(s.setupSecret)) != 1 {
		writeErr(w, http.StatusForbidden, "setup_secret", "this hub needs its setup secret to create a team")
		return
	}
	var req identityBody
	if !decode(w, r, &req) {
		return
	}
	name, ok := checkIdentity(w, req.UserID, req.DisplayName)
	if !ok {
		return
	}
	repoID := chi.URLParam(r, "repo_id")
	if !validRepoID(repoID) {
		writeErr(w, http.StatusBadRequest, "invalid_repo", "repo_id must be 1 to 200 characters, without braces or spaces")
		return
	}
	m, token, err := s.teams.Create(r.Context(), repoID, req.UserID, name)
	if err != nil {
		s.teamErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, signedIn{Member: m, Token: token})
}

type teamView struct {
	You     team.Member   `json:"you"`
	Members []team.Member `json:"members"`
	// Only for those who share: owners and admins.
	Invites []team.Invite `json:"invites,omitempty"`
}

func (s *Server) handleGetTeam(w http.ResponseWriter, r *http.Request) {
	me, repoID, ok := s.member(w, r)
	if !ok {
		return
	}
	members, err := s.teams.Members(r.Context(), repoID)
	if err != nil {
		s.teamErr(w, err)
		return
	}
	view := teamView{You: me, Members: members}
	if team.CanSeeInvites(me.Role) {
		if view.Invites, err = s.teams.Invites(r.Context(), repoID); err != nil {
			s.teamErr(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, view)
}

type joinBody struct {
	Code        string `json:"code"`
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
}

// Join needs no token: the invite code is the proof.
func (s *Server) handleJoinTeam(w http.ResponseWriter, r *http.Request) {
	var req joinBody
	if !decode(w, r, &req) {
		return
	}
	if req.Code == "" {
		writeErr(w, http.StatusBadRequest, "missing_field", "code is required")
		return
	}
	name, ok := checkIdentity(w, req.UserID, req.DisplayName)
	if !ok {
		return
	}
	m, token, err := s.teams.Join(r.Context(), chi.URLParam(r, "repo_id"), req.Code, req.UserID, name)
	if err != nil {
		s.teamErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, signedIn{Member: m, Token: token})
}

type inviteBody struct {
	Role     team.Role `json:"role"`
	TTLHours int       `json:"ttl_hours"`
	MaxUses  int       `json:"max_uses"`
}

type inviteView struct {
	Invite team.Invite `json:"invite"`
	// Code is shown once, to the inviter, to pass on to the invitee.
	Code string `json:"code"`
}

func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	me, repoID, ok := s.member(w, r)
	if !ok {
		return
	}
	var req inviteBody
	if !decode(w, r, &req) {
		return
	}
	if req.Role == "" {
		req.Role = team.RoleMember
	}
	ttl := defaultInviteTTL
	if req.TTLHours > 0 {
		// Clamp the hours before multiplying: a huge number would overflow into the past.
		ttl = time.Duration(min(req.TTLHours, int(maxInviteTTL/time.Hour))) * time.Hour
	}
	inv, code, err := s.teams.CreateInvite(r.Context(), repoID, me, req.Role, ttl, req.MaxUses)
	if err != nil {
		s.teamErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, inviteView{Invite: inv, Code: code})
}

func (s *Server) handleRevokeInvite(w http.ResponseWriter, r *http.Request) {
	me, repoID, ok := s.member(w, r)
	if !ok {
		return
	}
	if err := s.teams.RevokeInvite(r.Context(), repoID, me, chi.URLParam(r, "invite_id")); err != nil {
		s.teamErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type roleBody struct {
	Role team.Role `json:"role"`
}

func (s *Server) handleSetRole(w http.ResponseWriter, r *http.Request) {
	me, repoID, ok := s.member(w, r)
	if !ok {
		return
	}
	var req roleBody
	if !decode(w, r, &req) {
		return
	}
	m, err := s.teams.SetRole(r.Context(), repoID, me, chi.URLParam(r, "user_id"), req.Role)
	if err != nil {
		s.teamErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// Removing yourself is leaving.
func (s *Server) handleRemoveMember(w http.ResponseWriter, r *http.Request) {
	me, repoID, ok := s.member(w, r)
	if !ok {
		return
	}
	if err := s.teams.Remove(r.Context(), repoID, me, chi.URLParam(r, "user_id")); err != nil {
		s.teamErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type transferBody struct {
	UserID string `json:"user_id"`
}

func (s *Server) handleTransfer(w http.ResponseWriter, r *http.Request) {
	me, repoID, ok := s.member(w, r)
	if !ok {
		return
	}
	var req transferBody
	if !decode(w, r, &req) {
		return
	}
	m, err := s.teams.Transfer(r.Context(), repoID, me, req.UserID)
	if err != nil {
		s.teamErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// checkIdentity validates who someone says they are when they create or join a
// team, and returns the name to show (the user id when they gave none). It
// writes a 400 and returns false when either is unfit.
func checkIdentity(w http.ResponseWriter, userID, displayName string) (string, bool) {
	if !team.ValidUserID(userID) {
		writeErr(w, http.StatusBadRequest, "invalid_user_id", "user_id must be 1 to 64 letters, digits, '.', '_', '@' or '-'")
		return "", false
	}
	if strings.TrimSpace(displayName) == "" {
		displayName = userID
	}
	name, ok := team.CleanDisplayName(displayName)
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid_display_name", "display_name must be 1 to 80 characters with no control characters")
		return "", false
	}
	return name, true
}

// validRepoID keeps repo ids usable as a Redis hash tag: braces would split the
// team's keys across cluster slots.
func validRepoID(id string) bool {
	return id != "" && len(id) <= 200 && !strings.ContainsAny(id, "{} \t\r\n")
}
