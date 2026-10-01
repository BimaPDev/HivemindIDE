package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/BimaPDev/HivemindIDE/coordination/internal/lease"
	"github.com/BimaPDev/HivemindIDE/coordination/internal/presence"
	"github.com/BimaPDev/HivemindIDE/coordination/internal/team"
	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

const (
	pingInterval = 30 * time.Second
	// A client that misses two pings is gone. The contract tells clients to
	// reconnect with backoff rather than assume the stream is still live.
	pongWait  = 2*pingInterval + 5*time.Second
	writeWait = 10 * time.Second
)

var upgrader = websocket.Upgrader{
	// The hub is bound to localhost and the sidebar panel is not a browser
	// origin, so origin checking would only break the demo page.
	CheckOrigin: func(*http.Request) bool { return true },
}

// handleStream is what the fork's sidebar panel subscribes to. It sends one
// snapshot, then every event published for the repo.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repo_id")
	me, open, ok := s.authorize(w, r, repoID)
	if !ok {
		return
	}

	// Take the snapshot before subscribing would race the other way round: an
	// event published between the two would be lost. Subscribe first, then
	// snapshot, and let the client tolerate one duplicate.
	ctx := r.Context()
	sub, messages := s.presence.Subscribe(ctx, repoID)
	defer sub.Close()

	// Access may have changed between the check above and the subscription;
	// from here on, any change arrives as an event.
	if _, stillOpen, ok := s.authorize(w, r, repoID); !ok {
		return
	} else if stillOpen != open {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "this repo has a team: sign in with a member's token")
		return
	}

	snap, err := s.snapshot(r, repoID)
	if err != nil {
		s.log.Error("stream snapshot failed", "err", err, "repo", repoID)
		writeErr(w, http.StatusInternalServerError, "lookup_failed", "could not read presence")
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade already wrote a response.
		s.log.Warn("websocket upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	conn.SetReadLimit(1024)
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	// The panel never sends us anything, but we still have to drain the read
	// side for the pong handler and close frames to be processed.
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	if r.URL.Query().Get("only") == "team" {
		snap = presenceSnapshot{Sessions: []presence.Session{}, Leases: []lease.Lease{}}
	}
	if err := writeEvent(conn, presence.Event{
		Type: presence.EventSnapshot,
		At:   time.Now().UTC(),
		Data: snap,
	}); err != nil {
		return
	}

	// ?only=team: a client that only tracks the team (who joined, left or
	// changed role) is spared every presence and lease event.
	onlyTeam := r.URL.Query().Get("only") == "team"

	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-closed:
			return
		case msg, ok := <-messages:
			if !ok {
				return
			}
			// Events arrive already encoded; forward the bytes rather than
			// decoding and re-encoding them.
			if reason := lostAccess(msg.Payload, me.UserID, open); reason != "" {
				// Nothing published after the change reaches this stream: events
				// arrive in order, and this is the last one it reads.
				_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(closeLostAccess, reason), time.Now().Add(writeWait))
				return
			}
			if onlyTeam && !strings.Contains(msg.Payload, `"type":"team.`) {
				continue
			}
			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.TextMessage, []byte(msg.Payload)); err != nil {
				return
			}
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// closeLostAccess is the close code a stream ends with when its viewer may no
// longer see the repo; the client should not reconnect with the same token.
const closeLostAccess = 4001

// lostAccess says why a stream must close on this event, or "" to keep going:
// its member was removed, or the repo it was watching without a token just got
// a team. Only team events are decoded; everything else passes straight through.
func lostAccess(payload, userID string, open bool) string {
	if !strings.Contains(payload, `"type":"team.`) {
		return ""
	}
	var ev struct {
		Type string `json:"type"`
		Data struct {
			UserID string `json:"user_id"`
		} `json:"data"`
	}
	if json.Unmarshal([]byte(payload), &ev) != nil {
		return ""
	}
	switch {
	case ev.Type == team.EventTeamCreated && open:
		return "this repo now has a team: sign in to keep watching"
	case ev.Type == team.EventMemberRemoved && !open && ev.Data.UserID == userID:
		return "you were removed from this repo's team"
	}
	return ""
}

func writeEvent(conn *websocket.Conn, ev presence.Event) error {
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
	return conn.WriteMessage(websocket.TextMessage, body)
}
