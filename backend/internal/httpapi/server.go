// Package httpapi exposes the services over HTTP using the standard library
// router (Go 1.22+ method/path patterns). No framework: the middleware stack
// is a handful of small, testable functions.
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/atakank/vault-rush/backend/internal/analytics"
	"github.com/atakank/vault-rush/backend/internal/auth"
	"github.com/atakank/vault-rush/backend/internal/cache"
	"github.com/atakank/vault-rush/backend/internal/gameplay"
	"github.com/atakank/vault-rush/backend/internal/leaderboard"
	"github.com/atakank/vault-rush/backend/internal/liveops"
	"github.com/atakank/vault-rush/backend/internal/player"
	"github.com/atakank/vault-rush/backend/internal/reward"
	"github.com/atakank/vault-rush/backend/internal/shop"
	"github.com/atakank/vault-rush/backend/internal/store"
	"github.com/atakank/vault-rush/backend/internal/telemetry"
)

// Deps is everything the HTTP layer needs.
type Deps struct {
	Log       *slog.Logger
	Version   string
	StartedAt time.Time

	Tokens     *auth.Issuer
	AdminToken string

	Players     *player.Service
	Gameplay    *gameplay.Service
	Liveops     *liveops.Service
	Leaderboard *leaderboard.Service
	Rewards     *reward.Service
	Shop        *shop.Service
	Analytics   *analytics.Service

	Store     store.Store
	Cache     cache.Cache
	Bus       *telemetry.Bus
	QueueMode string
	QueuePing func(ctx context.Context) error

	RateLimitPerMin int
	IdempotencyTTL  time.Duration
	CORSOrigins     []string
}

type server struct {
	d          Deps
	metricsReg *Metrics
}

// draining flips /readyz to 503 during graceful shutdown so load balancers
// stop routing new traffic while in-flight requests complete.
var draining atomic.Bool

// SetDraining marks the process as shutting down.
func SetDraining(v bool) { draining.Store(v) }

// NewHandler builds the full router with middleware.
func NewHandler(d Deps) http.Handler {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.StartedAt.IsZero() {
		d.StartedAt = time.Now()
	}
	if d.IdempotencyTTL <= 0 {
		d.IdempotencyTTL = 24 * time.Hour
	}
	s := &server{d: d, metricsReg: NewMetrics()}
	mux := http.NewServeMux()

	// Ops
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /readyz", s.readyz)
	mux.HandleFunc("GET /metrics", s.metrics)

	// Public
	mux.Handle("POST /v1/player", http.HandlerFunc(s.createPlayer))

	// Authenticated player API
	authed := func(h http.HandlerFunc, extra ...middleware) http.Handler {
		ms := []middleware{bearerAuth(d.Tokens), rateLimit(d.Cache.RateLimiter(), d.RateLimitPerMin, d.Log)}
		ms = append(ms, extra...)
		return chain(h, ms...)
	}
	idem := idempotent(d.Store.Idempotency(), d.IdempotencyTTL, d.Log)

	mux.Handle("GET /v1/player/profile", authed(s.profile))
	mux.Handle("GET /v1/events/current", authed(s.currentEvent))
	mux.Handle("POST /v1/heists/start", authed(s.startHeist, idem))
	mux.Handle("POST /v1/heists/{runId}/finish", authed(s.finishHeist, idem))
	mux.Handle("GET /v1/leaderboard/global", authed(s.leaderboardGlobal))
	mux.Handle("GET /v1/leaderboard/friends", authed(s.leaderboardFriends))
	mux.Handle("GET /v1/rewards", authed(s.listRewards))
	mux.Handle("POST /v1/rewards/claim", authed(s.claimReward, idem))
	mux.Handle("GET /v1/shop/catalog", authed(s.catalog))
	mux.Handle("POST /v1/shop/purchase", authed(s.purchase, idem))

	// Admin / LiveOps
	admin := func(h http.HandlerFunc) http.Handler { return chain(h, adminAuth(d.AdminToken)) }
	mux.Handle("GET /admin/v1/events", admin(s.adminListEvents))
	mux.Handle("POST /admin/v1/events", admin(s.adminCreateEvent))
	mux.Handle("GET /admin/v1/events/{eventId}", admin(s.adminGetEvent))
	mux.Handle("GET /admin/v1/events/{eventId}/config/{version}", admin(s.adminGetConfigVersion))
	mux.Handle("PUT /admin/v1/events/{eventId}/config", admin(s.adminPublishConfig))
	mux.Handle("GET /admin/v1/events/{eventId}/analytics", admin(s.adminAnalytics))
	mux.Handle("GET /admin/v1/experiments", admin(s.adminExperiments))
	mux.Handle("GET /admin/v1/players/{playerId}", admin(s.adminGetPlayer))
	mux.Handle("POST /admin/v1/players/{playerId}/grant", admin(s.adminGrant))
	mux.Handle("GET /admin/v1/system", admin(s.adminSystem))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "no such route")
	})

	return chain(mux,
		recoverer(d.Log),
		requestID(),
		instrument(s.metricsReg, d.Log),
		cors(d.CORSOrigins),
		maxBody(1<<20),
	)
}

func (s *server) depsHealth(r *http.Request) (map[string]string, bool) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	deps := map[string]string{}
	ok := true
	check := func(name string, fn func(context.Context) error) {
		if fn == nil {
			deps[name] = "ok" // no external dependency in this mode (e.g. inline queue)
			return
		}
		if err := fn(ctx); err != nil {
			deps[name] = "down: " + err.Error()
			ok = false
			return
		}
		deps[name] = "ok"
	}
	check(s.d.Store.Name(), s.d.Store.Ping)
	check(s.d.Cache.Name(), s.d.Cache.Ping)
	check("queue", s.d.QueuePing)
	return deps, ok
}
