// Command permissiond serves the permission filter API.
//
// It binds to 127.0.0.1 by default: the service trusts whatever user_id its
// caller claims, so it must not be reachable off the machine. See the
// "Trust boundary" section of contract/README.md.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/BimaPDev/HivemindIDE/permission/internal/api"
	"github.com/BimaPDev/HivemindIDE/permission/internal/store"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	addr := env("PERMISSION_ADDR", "127.0.0.1:8081")
	dsn := env("PERMISSION_DATABASE_URL",
		"postgres://hivemindide:hivemindide@localhost:5432/hivemindide?sslmode=disable")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := connectWithRetry(ctx, dsn, log)
	if err != nil {
		log.Error("could not reach postgres", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := db.Migrate(ctx); err != nil {
		log.Error("migration failed", "err", err)
		os.Exit(1)
	}
	log.Info("schema up to date")

	srv := &http.Server{
		Addr:              addr,
		Handler:           api.New(db, log).Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		// The filter sits in front of a model call, so a slow request here
		// stalls the editor's AI panel. Keep the budget tight.
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	go func() {
		log.Info("permissiond listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server failed", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "err", err)
	}
}

// connectWithRetry tolerates Postgres not being up yet, which is the normal case
// under docker compose.
func connectWithRetry(ctx context.Context, dsn string, log *slog.Logger) (*store.Postgres, error) {
	var lastErr error
	for attempt := 1; attempt <= 30; attempt++ {
		db, err := store.NewPostgres(ctx, dsn)
		if err == nil {
			return db, nil
		}
		lastErr = err
		log.Info("waiting for postgres", "attempt", attempt)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return nil, lastErr
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
