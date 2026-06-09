// Package cache defines the low-latency, in-memory-database ports backed by
// Redis in production and by a process-local implementation otherwise.
//
// Everything here is treated as *derived* state: losing it degrades the
// experience (leaderboard lags, a rate limit resets) but never loses a
// player's progress, which lives in the store package.
package cache

import (
	"context"
	"time"
)

// Entry is one leaderboard row.
type Entry struct {
	Rank     int64  `json:"rank"`
	PlayerID string `json:"playerId"`
	Name     string `json:"name"`
	Score    int64  `json:"score"`
}

// Leaderboard is a sorted-set ranking per event.
type Leaderboard interface {
	// Submit records score for the player, keeping the best (ZADD GT).
	Submit(ctx context.Context, eventID, playerID, name string, score int64) error
	Top(ctx context.Context, eventID string, limit int) ([]Entry, error)
	// Rank is 1-based. found=false when the player has no score.
	Rank(ctx context.Context, eventID, playerID string) (rank, score int64, found bool, err error)
	// Around returns the players ranked within ±radius of the given player.
	Around(ctx context.Context, eventID, playerID string, radius int) ([]Entry, error)
	Count(ctx context.Context, eventID string) (int64, error)
}

// Analytics keeps cheap aggregate counters per event (Redis hash + set).
type Analytics interface {
	IncrMany(ctx context.Context, eventID string, fields map[string]int64) error
	// AddUnique adds member to a per-event set and reports whether it was new.
	AddUnique(ctx context.Context, eventID, set, member string) (bool, error)
	Snapshot(ctx context.Context, eventID string) (map[string]int64, error)
}

// RateLimiter is a token bucket keyed by an arbitrary string.
type RateLimiter interface {
	Allow(ctx context.Context, key string, limit int, window time.Duration) (allowed bool, retryAfter time.Duration, err error)
}

// KV is a byte cache with TTL used for hot config.
type KV interface {
	Get(ctx context.Context, key string) ([]byte, bool, error)
	Set(ctx context.Context, key string, val []byte, ttl time.Duration) error
	Del(ctx context.Context, key string) error
}

// Cache aggregates the ports behind one connection.
type Cache interface {
	Leaderboard() Leaderboard
	Analytics() Analytics
	RateLimiter() RateLimiter
	KV() KV
	Ping(ctx context.Context) error
	Name() string
	Close() error
}
