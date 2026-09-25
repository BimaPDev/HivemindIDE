// Command coordinationd serves the lease and presence API.
//
// Like permissiond, it binds to 127.0.0.1 and trusts the session_id its caller
// claims. See the "Trust boundary" section of contract/README.md.
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

	"github.com/BimaPDev/HivemindIDE/coordination/internal/api"
	"github.com/BimaPDev/HivemindIDE/coordination/internal/lease"
	"github.com/BimaPDev/HivemindIDE/coordination/internal/presence"
	"github.com/redis/go-redis/v9"
)

const sweepInterval = 5 * time.Second

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	addr := env("COORDINATION_ADDR", "127.0.0.1:8082")
	redisAddr := env("COORDINATION_REDIS_ADDR", "localhost:6379")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer rdb.Close()

	if err := pingWithRetry(ctx, rdb, log); err != nil {
		log.Error("could not reach redis", "err", err, "addr", redisAddr)
		os.Exit(1)
	}
	log.Info("connected to redis", "addr", redisAddr)

	leases := lease.NewManager(rdb)
	sessions := presence.NewStore(rdb)

	sweeper := presence.NewSweeper(rdb, sessions, sweepInterval, log)
	go sweeper.Run(ctx)

	srv := &http.Server{
		Addr:              addr,
		Handler:           api.New(leases, sessions, rdb, log).Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		// No WriteTimeout: the presence stream is a long-lived WebSocket, and a
		// write deadline here would kill it. Per-message deadlines are set in
		// the stream handler instead.
	}

	go func() {
		log.Info("coordinationd listening", "addr", addr)
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

func pingWithRetry(ctx context.Context, rdb *redis.Client, log *slog.Logger) error {
	var lastErr error
	for attempt := 1; attempt <= 30; attempt++ {
		if err := rdb.Ping(ctx).Err(); err == nil {
			return nil
		} else {
			lastErr = err
		}
		log.Info("waiting for redis", "attempt", attempt)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return lastErr
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
