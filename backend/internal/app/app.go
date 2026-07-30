// Package app wires configuration into concrete adapters and services. Both
// binaries (api, worker) use it so the dependency graph lives in one place.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/atakank/vault-rush/backend/internal/analytics"
	"github.com/atakank/vault-rush/backend/internal/auth"
	"github.com/atakank/vault-rush/backend/internal/cache"
	cachemem "github.com/atakank/vault-rush/backend/internal/cache/memory"
	cacheredis "github.com/atakank/vault-rush/backend/internal/cache/redis"
	"github.com/atakank/vault-rush/backend/internal/config"
	"github.com/atakank/vault-rush/backend/internal/gameplay"
	"github.com/atakank/vault-rush/backend/internal/httpapi"
	"github.com/atakank/vault-rush/backend/internal/leaderboard"
	"github.com/atakank/vault-rush/backend/internal/liveops"
	"github.com/atakank/vault-rush/backend/internal/player"
	"github.com/atakank/vault-rush/backend/internal/queue"
	"github.com/atakank/vault-rush/backend/internal/reward"
	"github.com/atakank/vault-rush/backend/internal/shop"
	"github.com/atakank/vault-rush/backend/internal/store"
	storedynamo "github.com/atakank/vault-rush/backend/internal/store/dynamo"
	storemem "github.com/atakank/vault-rush/backend/internal/store/memory"
	"github.com/atakank/vault-rush/backend/internal/telemetry"
)

// Role selects which sinks the telemetry bus gets.
type Role string

const (
	RoleAPI    Role = "api"
	RoleWorker Role = "worker"
)

// App is the assembled dependency graph.
type App struct {
	Cfg   config.Config
	Log   *slog.Logger
	Store store.Store
	Cache cache.Cache
	Queue *queue.Client // nil unless QUEUE=sqs
	Bus   *telemetry.Bus

	Tokens      *auth.Issuer
	Players     *player.Service
	Liveops     *liveops.Service
	Leaderboard *leaderboard.Service
	Rewards     *reward.Service
	Gameplay    *gameplay.Service
	Shop        *shop.Service
	Analytics   *analytics.Service
	Distributor *reward.Distributor

	startedAt time.Time
}

// NewLogger builds the structured logger.
func NewLogger(level, env string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lvl}
	if env == "local" {
		return slog.New(slog.NewTextHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, opts))
}

// Build constructs adapters and services for a role.
func Build(ctx context.Context, cfg config.Config, log *slog.Logger, role Role) (*App, error) {
	a := &App{Cfg: cfg, Log: log, startedAt: time.Now()}

	// Storage
	switch cfg.Storage {
	case "dynamodb":
		st, err := storedynamo.New(ctx, storedynamo.Options{Table: cfg.DynamoTable, Region: cfg.AWSRegion, Endpoint: cfg.DynamoURL})
		if err != nil {
			return nil, err
		}
		if cfg.DynamoURL != "" { // local: create the table on the fly
			if err := st.EnsureTable(ctx); err != nil {
				return nil, fmt.Errorf("dynamodb ensure table: %w", err)
			}
		}
		a.Store = st
	default:
		a.Store = storemem.New()
	}

	// Cache
	switch cfg.Cache {
	case "redis":
		c, err := cacheredis.New(ctx, cfg.RedisAddr, cfg.RedisPass)
		if err != nil {
			return nil, err
		}
		a.Cache = c
	default:
		a.Cache = cachemem.New()
	}

	// Queue
	if cfg.Queue == "sqs" {
		q, err := queue.New(ctx, queue.Options{QueueURL: cfg.SQSQueueURL, Region: cfg.AWSRegion, Endpoint: cfg.SQSEndpoint})
		if err != nil {
			return nil, err
		}
		a.Queue = q
	}

	// Telemetry sinks depend on role + queue mode.
	var sinks []telemetry.Sink
	realSinks := []telemetry.Sink{analytics.NewSink(a.Cache.Analytics()), leaderboard.NewSink(a.Cache.Leaderboard())}
	switch {
	case role == RoleAPI && a.Queue != nil:
		sinks = []telemetry.Sink{queue.NewPublisher(a.Queue)}
	default:
		sinks = realSinks
	}
	a.Bus = telemetry.NewBus(cfg.TelemetryBuffer, cfg.TelemetryWorkers, sinks, log)

	// Services
	a.Tokens = auth.New(cfg.TokenSecret, cfg.TokenTTL)
	a.Players = player.New(a.Store, a.Tokens, a.Bus, cfg.LifeRegen)
	a.Liveops = liveops.New(a.Store, a.Cache.KV(), cfg.EventSeedSalt)
	a.Leaderboard = leaderboard.New(a.Cache.Leaderboard())
	a.Rewards = reward.New(a.Store, a.Players, a.Bus, log)
	a.Gameplay = gameplay.New(a.Store, a.Players, a.Liveops, a.Rewards, a.Bus, cfg.RunTTL, log)
	a.Shop = shop.New(a.Players, a.Bus)
	a.Analytics = analytics.New(a.Cache.Analytics())
	a.Distributor = reward.NewDistributor(a.Rewards, a.Liveops, a.Leaderboard, log)
	return a, nil
}

// Handler builds the HTTP router.
func (a *App) Handler() http.Handler {
	var qping func(context.Context) error
	if a.Queue != nil {
		qping = a.Queue.Ping
	}
	return httpapi.NewHandler(httpapi.Deps{
		Log: a.Log, Version: a.Cfg.Version, StartedAt: a.startedAt,
		Tokens: a.Tokens, AdminToken: a.Cfg.AdminToken,
		Players: a.Players, Gameplay: a.Gameplay, Liveops: a.Liveops, Leaderboard: a.Leaderboard,
		Rewards: a.Rewards, Shop: a.Shop, Analytics: a.Analytics,
		Store: a.Store, Cache: a.Cache, Bus: a.Bus, QueueMode: a.Cfg.Queue, QueuePing: qping,
		RateLimitPerMin: a.Cfg.RateLimitPerMin, IdempotencyTTL: a.Cfg.IdempotencyTTL, CORSOrigins: a.Cfg.CORSOrigins,
	})
}

// Close releases connections.
func (a *App) Close() error {
	var errs []error
	if a.Cache != nil {
		errs = append(errs, a.Cache.Close())
	}
	if a.Store != nil {
		errs = append(errs, a.Store.Close())
	}
	return errors.Join(errs...)
}
