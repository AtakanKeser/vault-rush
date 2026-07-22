package httpapi

import (
	"bytes"
	"context"
	"crypto/subtle"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/atakank/vault-rush/backend/internal/auth"
	"github.com/atakank/vault-rush/backend/internal/cache"
	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/ids"
	"github.com/atakank/vault-rush/backend/internal/store"
)

type ctxKey int

const (
	ctxPlayerID ctxKey = iota
	ctxRequestID
)

// PlayerID returns the authenticated player from the context.
func PlayerID(ctx context.Context) string {
	v, _ := ctx.Value(ctxPlayerID).(string)
	return v
}

// RequestID returns the request id from the context.
func RequestID(ctx context.Context) string {
	v, _ := ctx.Value(ctxRequestID).(string)
	return v
}

type middleware func(http.Handler) http.Handler

func chain(h http.Handler, ms ...middleware) http.Handler {
	for i := len(ms) - 1; i >= 0; i-- {
		h = ms[i](h)
	}
	return h
}

func recoverer(log *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					log.Error("panic recovered", "err", fmt.Sprint(rec), "stack", string(debug.Stack()), "requestId", RequestID(r.Context()))
					writeError(w, http.StatusInternalServerError, "INTERNAL", "internal error")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

func requestID() middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := r.Header.Get("X-Request-Id")
			if id == "" || len(id) > 128 {
				id = ids.New("req")
			}
			w.Header().Set("X-Request-Id", id)
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxRequestID, id)))
		})
	}
}

func instrument(m *Metrics, log *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w}
			next.ServeHTTP(sw, r)
			d := time.Since(start)
			route := r.Pattern
			if route == "" {
				route = r.Method + " (unmatched)"
			}
			m.Observe(route, sw.status, d)
			lvl := slog.LevelInfo
			if sw.status >= 500 {
				lvl = slog.LevelError
			} else if sw.status >= 400 {
				lvl = slog.LevelWarn
			}
			if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
				lvl = slog.LevelDebug
			}
			log.Log(r.Context(), lvl, "http",
				"method", r.Method, "path", r.URL.Path, "route", route, "status", sw.status,
				"ms", float64(d.Microseconds())/1000, "bytes", sw.bytes, "player", PlayerID(r.Context()), "requestId", RequestID(r.Context()))
		})
	}
}

func cors(origins []string) middleware {
	allowAll := len(origins) == 0
	set := map[string]bool{}
	for _, o := range origins {
		if o == "*" {
			allowAll = true
		}
		set[o] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && (allowAll || set[origin]) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Request-Id, X-Admin-Token")
				w.Header().Set("Access-Control-Expose-Headers", "X-Request-Id, Idempotent-Replayed, Retry-After")
				w.Header().Set("Access-Control-Max-Age", "600")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func bearerAuth(tokens *auth.Issuer) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := r.Header.Get("Authorization")
			if !strings.HasPrefix(h, "Bearer ") {
				writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "missing bearer token")
				return
			}
			pid, err := tokens.Verify(strings.TrimSpace(h[7:]))
			if err != nil {
				writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid token")
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxPlayerID, pid)))
		})
	}
}

func adminAuth(token string) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := r.Header.Get("X-Admin-Token")
			if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
				writeError(w, http.StatusForbidden, "FORBIDDEN", "invalid admin token")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// rateLimit is a per-player token bucket. When the limiter backend is down we
// fail open: gameplay availability beats abuse protection for a few seconds.
func rateLimit(rl cache.RateLimiter, perMinute int, log *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		if perMinute <= 0 {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := "rl:" + PlayerID(r.Context())
			allowed, retry, err := rl.Allow(r.Context(), key, perMinute, time.Minute)
			if err != nil {
				log.Warn("rate limiter unavailable, failing open", "err", err)
				next.ServeHTTP(w, r)
				return
			}
			if !allowed {
				secs := int(retry.Seconds()) + 1
				w.Header().Set("Retry-After", strconv.Itoa(secs))
				writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "too many requests")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// recordingWriter buffers a response so it can be stored for idempotent replay.
type recordingWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (rw *recordingWriter) Header() http.Header { return rw.header }
func (rw *recordingWriter) WriteHeader(code int) {
	if rw.status == 0 {
		rw.status = code
	}
}
func (rw *recordingWriter) Write(b []byte) (int, error) {
	if rw.status == 0 {
		rw.status = http.StatusOK
	}
	return rw.body.Write(b)
}

// idempotent makes a mutating handler safe to retry. Scope: (player, key).
func idempotent(idem store.Idempotency, ttl time.Duration, log *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
			if key == "" {
				next.ServeHTTP(w, r)
				return
			}
			if len(key) > 128 {
				writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Idempotency-Key too long")
				return
			}
			pid := PlayerID(r.Context())
			rec, acquired, err := idem.Begin(r.Context(), pid, key, ttl)
			if err != nil {
				log.Warn("idempotency store unavailable, processing without protection", "err", err)
				next.ServeHTTP(w, r)
				return
			}
			if !acquired {
				if rec.State == domain.IdempotencyInProgress {
					writeError(w, http.StatusConflict, "IDEMPOTENCY_IN_PROGRESS", "a request with this key is still being processed")
					return
				}
				w.Header().Set("Idempotent-Replayed", "true")
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(rec.StatusCode)
				_, _ = w.Write(rec.Body)
				return
			}
			rw := &recordingWriter{header: w.Header().Clone()}
			next.ServeHTTP(rw, r)
			if rw.status == 0 {
				rw.status = http.StatusOK
			}
			if rw.status >= 500 {
				_ = idem.Abort(r.Context(), pid, key) // let the client retry a failed attempt
			} else if err := idem.Complete(r.Context(), pid, key, rw.status, rw.body.Bytes()); err != nil {
				log.Warn("idempotency complete failed", "err", err)
			}
			for k, v := range rw.header {
				w.Header()[k] = v
			}
			w.WriteHeader(rw.status)
			_, _ = w.Write(rw.body.Bytes())
		})
	}
}

func maxBody(n int64) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil {
				r.Body = http.MaxBytesReader(w, r.Body, n)
			}
			next.ServeHTTP(w, r)
		})
	}
}
