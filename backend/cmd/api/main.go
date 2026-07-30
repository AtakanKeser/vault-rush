// Command api serves the Vault Rush HTTP API.
//
// Shutdown sequence on SIGTERM/SIGINT:
//  1. flip /readyz to 503, then stop accepting new connections (http.Server.Shutdown)
//  2. let in-flight requests finish (bounded by shutdownTimeout)
//  3. drain the telemetry channel so accepted events reach their sinks
//  4. close cache/store connections
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/atakank/vault-rush/backend/internal/app"
	"github.com/atakank/vault-rush/backend/internal/config"
	"github.com/atakank/vault-rush/backend/internal/httpapi"
)

var version = "dev"

const shutdownTimeout = 20 * time.Second

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.Version == "dev" {
		cfg.Version = version
	}
	log := app.NewLogger(cfg.LogLevel, cfg.Env)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	a, err := app.Build(ctx, cfg, log, app.RoleAPI)
	if err != nil {
		return err
	}

	// Sinks keep running through shutdown; only Shutdown() closes them.
	busCtx, busCancel := context.WithCancel(context.Background())
	defer busCancel()
	a.Bus.Start(busCtx)

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           a.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return context.Background() },
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("api listening", "addr", srv.Addr, "version", cfg.Version, "storage", a.Store.Name(), "cache", a.Cache.Name(), "queue", cfg.Queue, "env", cfg.Env)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	log.Info("shutdown: signal received, draining")
	httpapi.SetDraining(true) // /readyz → 503: the load balancer stops sending new traffic
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Warn("shutdown: http server did not drain cleanly", "err", err)
	} else {
		log.Info("shutdown: http server drained")
	}
	if err := a.Bus.Shutdown(shutdownCtx); err != nil {
		log.Warn("shutdown: telemetry bus did not drain cleanly", "err", err, "stats", a.Bus.Stats())
	} else {
		log.Info("shutdown: telemetry drained", "stats", a.Bus.Stats())
	}
	if err := a.Close(); err != nil {
		log.Warn("shutdown: closing dependencies", "err", err)
	}
	log.Info("shutdown: complete")
	return nil
}
