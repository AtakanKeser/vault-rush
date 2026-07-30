// Command worker consumes telemetry from SQS and runs scheduled jobs.
//
// With QUEUE=inline the API applies sinks in-process and the worker only runs
// the scheduler (leaderboard reward distribution). With QUEUE=sqs the worker
// is the only consumer of the events queue.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/atakank/vault-rush/backend/internal/app"
	"github.com/atakank/vault-rush/backend/internal/config"
	"github.com/atakank/vault-rush/backend/internal/queue"
)

var version = "dev"

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

	a, err := app.Build(ctx, cfg, log, app.RoleWorker)
	if err != nil {
		return err
	}
	busCtx, busCancel := context.WithCancel(context.Background())
	defer busCancel()
	a.Bus.Start(busCtx)

	var wg sync.WaitGroup

	// Health endpoint for the orchestrator.
	health := &http.Server{Addr: fmt.Sprintf(":%d", cfg.Port), ReadHeaderTimeout: 5 * time.Second}
	mux := http.NewServeMux()
	var consumer *queue.Consumer
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok"}`)
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		stats := a.Bus.Stats()
		processed, failed := int64(0), int64(0)
		if consumer != nil {
			processed, failed = consumer.Stats()
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"telemetry":{"queueDepth":%d,"capacity":%d,"workers":%d,"processed":%d,"dropped":%d,"retries":%d,"failed":%d},"consumer":{"processed":%d,"failed":%d}}`,
			stats.QueueDepth, stats.Capacity, stats.Workers, stats.Processed, stats.Dropped, stats.Retries, stats.Failed, processed, failed)
	})
	health.Handler = mux
	go func() { _ = health.ListenAndServe() }()

	if a.Queue != nil {
		consumer = queue.NewConsumer(a.Queue, a.Bus, 2, log)
		wg.Add(1)
		go func() {
			defer wg.Done()
			log.Info("worker consuming", "queue", cfg.SQSQueueURL)
			consumer.Run(ctx)
		}()
	} else {
		log.Info("worker running in inline mode: no queue to consume, scheduler only")
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		log.Info("scheduler started", "job", "leaderboard-reward-distribution", "every", "60s")
		a.Distributor.Loop(ctx, 60*time.Second)
	}()

	<-ctx.Done()
	log.Info("shutdown: signal received")
	wg.Wait()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = health.Shutdown(shutdownCtx)
	if err := a.Bus.Shutdown(shutdownCtx); err != nil {
		log.Warn("shutdown: telemetry bus did not drain cleanly", "err", err)
	}
	if err := a.Close(); err != nil {
		log.Warn("shutdown: closing dependencies", "err", err)
	}
	log.Info("shutdown: complete", "stats", a.Bus.Stats())
	return nil
}
