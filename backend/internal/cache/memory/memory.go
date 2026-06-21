// Package memory is a process-local cache.Cache. It reproduces the Redis
// semantics the services rely on (ZADD GT ordering, hash counters, token
// buckets, TTLs) so tests and CACHE=memory deployments behave the same.
package memory

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/atakank/vault-rush/backend/internal/cache"
)

// Cache is the in-memory implementation.
type Cache struct {
	mu      sync.RWMutex
	boards  map[string]map[string]int64 // eventID -> playerID -> score
	names   map[string]string           // playerID -> display name
	counter map[string]map[string]int64 // eventID -> field -> value
	sets    map[string]map[string]struct{}
	buckets map[string]*bucket
	kv      map[string]kvItem
	now     func() time.Time
}

type bucket struct {
	tokens   float64
	lastFill time.Time
}

type kvItem struct {
	val []byte
	exp time.Time
}

// New creates an empty cache.
func New() *Cache {
	return &Cache{
		boards:  map[string]map[string]int64{},
		names:   map[string]string{},
		counter: map[string]map[string]int64{},
		sets:    map[string]map[string]struct{}{},
		buckets: map[string]*bucket{},
		kv:      map[string]kvItem{},
		now:     func() time.Time { return time.Now() },
	}
}

// WithClock overrides the clock (tests).
func (c *Cache) WithClock(now func() time.Time) *Cache { c.now = now; return c }

func (c *Cache) Leaderboard() cache.Leaderboard { return (*lb)(c) }
func (c *Cache) Analytics() cache.Analytics     { return (*an)(c) }
func (c *Cache) RateLimiter() cache.RateLimiter { return (*rl)(c) }
func (c *Cache) KV() cache.KV                   { return (*kv)(c) }
func (c *Cache) Ping(context.Context) error     { return nil }
func (c *Cache) Name() string                   { return "memory" }
func (c *Cache) Close() error                   { return nil }

// ---- leaderboard ----

type lb Cache

func (l *lb) sorted(eventID string) []cache.Entry {
	board := l.boards[eventID]
	out := make([]cache.Entry, 0, len(board))
	for pid, sc := range board {
		out = append(out, cache.Entry{PlayerID: pid, Name: l.names[pid], Score: sc})
	}
	// Redis orders ties by member lexicographically (ZREVRANGE → descending).
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].PlayerID > out[j].PlayerID
	})
	for i := range out {
		out[i].Rank = int64(i + 1)
	}
	return out
}

func (l *lb) Submit(_ context.Context, eventID, playerID, name string, score int64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	board, ok := l.boards[eventID]
	if !ok {
		board = map[string]int64{}
		l.boards[eventID] = board
	}
	if cur, ok := board[playerID]; !ok || score > cur {
		board[playerID] = score
	}
	if name != "" {
		l.names[playerID] = name
	}
	return nil
}

func (l *lb) Top(_ context.Context, eventID string, limit int) ([]cache.Entry, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	all := l.sorted(eventID)
	if limit > 0 && len(all) > limit {
		all = all[:limit]
	}
	return all, nil
}

func (l *lb) Rank(_ context.Context, eventID, playerID string) (int64, int64, bool, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	for _, e := range l.sorted(eventID) {
		if e.PlayerID == playerID {
			return e.Rank, e.Score, true, nil
		}
	}
	return 0, 0, false, nil
}

func (l *lb) Around(_ context.Context, eventID, playerID string, radius int) ([]cache.Entry, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	all := l.sorted(eventID)
	idx := -1
	for i, e := range all {
		if e.PlayerID == playerID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return []cache.Entry{}, nil
	}
	lo, hi := max(0, idx-radius), min(len(all), idx+radius+1)
	return append([]cache.Entry(nil), all[lo:hi]...), nil
}

func (l *lb) Count(_ context.Context, eventID string) (int64, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return int64(len(l.boards[eventID])), nil
}

// ---- analytics ----

type an Cache

func (a *an) IncrMany(_ context.Context, eventID string, fields map[string]int64) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	m, ok := a.counter[eventID]
	if !ok {
		m = map[string]int64{}
		a.counter[eventID] = m
	}
	for k, v := range fields {
		m[k] += v
	}
	return nil
}

func (a *an) AddUnique(_ context.Context, eventID, set, member string) (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	k := eventID + ":" + set
	s, ok := a.sets[k]
	if !ok {
		s = map[string]struct{}{}
		a.sets[k] = s
	}
	if _, exists := s[member]; exists {
		return false, nil
	}
	s[member] = struct{}{}
	return true, nil
}

func (a *an) Snapshot(_ context.Context, eventID string) (map[string]int64, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make(map[string]int64, len(a.counter[eventID]))
	for k, v := range a.counter[eventID] {
		out[k] = v
	}
	return out, nil
}

// ---- rate limiter (token bucket) ----

type rl Cache

func (r *rl) Allow(_ context.Context, key string, limit int, window time.Duration) (bool, time.Duration, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	b, ok := r.buckets[key]
	if !ok {
		b = &bucket{tokens: float64(limit), lastFill: now}
		r.buckets[key] = b
	}
	rate := float64(limit) / window.Seconds() // tokens per second
	elapsed := now.Sub(b.lastFill).Seconds()
	b.tokens = min(float64(limit), b.tokens+elapsed*rate)
	b.lastFill = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0, nil
	}
	wait := time.Duration((1 - b.tokens) / rate * float64(time.Second))
	return false, wait, nil
}

// ---- kv ----

type kv Cache

func (k *kv) Get(_ context.Context, key string) ([]byte, bool, error) {
	k.mu.RLock()
	defer k.mu.RUnlock()
	it, ok := k.kv[key]
	if !ok || (!it.exp.IsZero() && k.now().After(it.exp)) {
		return nil, false, nil
	}
	return append([]byte(nil), it.val...), true, nil
}

func (k *kv) Set(_ context.Context, key string, val []byte, ttl time.Duration) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	var exp time.Time
	if ttl > 0 {
		exp = k.now().Add(ttl)
	}
	k.kv[key] = kvItem{val: append([]byte(nil), val...), exp: exp}
	return nil
}

func (k *kv) Del(_ context.Context, key string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.kv, key)
	return nil
}
