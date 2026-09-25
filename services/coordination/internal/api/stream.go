package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/BimaPDev/HivemindIDE/coordination/internal/presence"
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

	// Take the snapshot before subscribing would race the other way round: an
	// event published between the two would be lost. Subscribe first, then
	// snapshot, and let the client tolerate one duplicate.
	ctx := r.Context()
	sub, messages := s.presence.Subscribe(ctx, repoID)
	defer sub.Close()

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

	if err := writeEvent(conn, presence.Event{
		Type: presence.EventSnapshot,
		At:   time.Now().UTC(),
		Data: snap,
	}); err != nil {
		return
	}

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

func writeEvent(conn *websocket.Conn, ev presence.Event) error {
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
	return conn.WriteMessage(websocket.TextMessage, body)
}
