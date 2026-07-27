// Package redis implements cache.Cache on Redis (ElastiCache in production).
//
//	lb:<eventId>            ZSET  score → playerId   (ZADD GT, ZREVRANGE, ZREVRANK)
//	lb:names                HASH  playerId → display name
//	an:<eventId>            HASH  counter fields (HINCRBY)
//	an:<eventId>:set:<name> SET   unique members (SADD)
//	rl:<player>             token bucket state (Lua, atomic)
//	event:*                 hot config / meta JSON with TTL
package redis

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	goredis "github.com/redis/go-redis/v9"

	"github.com/atakank/vault-rush/backend/internal/cache"
)

// Cache is the Redis adapter.
type Cache struct {
	rdb *goredis.Client
}

// New connects to Redis.
func New(ctx context.Context, addr, password string) (*Cache, error) {
	rdb := goredis.NewClient(&goredis.Options{
		Addr:         addr,
		Password:     password,
		DialTimeout:  2 * time.Second,
		ReadTimeout:  500 * time.Millisecond,
		WriteTimeout: 500 * time.Millisecond,
		PoolSize:     64,
		MinIdleConns: 4,
	})
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping %s: %w", addr, err)
	}
	return &Cache{rdb: rdb}, nil
}

func (c *Cache) Leaderboard() cache.Leaderboard { return (*lb)(c) }
func (c *Cache) Analytics() cache.Analytics     { return (*an)(c) }
func (c *Cache) RateLimiter() cache.RateLimiter { return (*rl)(c) }
func (c *Cache) KV() cache.KV                   { return (*kv)(c) }
func (c *Cache) Ping(ctx context.Context) error { return c.rdb.Ping(ctx).Err() }
func (c *Cache) Name() string                   { return "redis" }
func (c *Cache) Close() error                   { return c.rdb.Close() }

// ---- leaderboard ----

type lb Cache

func lbKey(eventID string) string { return "lb:" + eventID }

const namesKey = "lb:names"

func (l *lb) Submit(ctx context.Context, eventID, playerID, name string, score int64) error {
	pipe := l.rdb.TxPipeline()
	pipe.ZAddGT(ctx, lbKey(eventID), goredis.Z{Score: float64(score), Member: playerID})
	pipe.Expire(ctx, lbKey(eventID), 14*24*time.Hour)
	if name != "" {
		pipe.HSet(ctx, namesKey, playerID, name)
	}
	_, err := pipe.Exec(ctx)
	return err
}

func (l *lb) hydrate(ctx context.Context, zs []goredis.Z, startRank int64) ([]cache.Entry, error) {
	if len(zs) == 0 {
		return []cache.Entry{}, nil
	}
	ids := make([]string, len(zs))
	for i, z := range zs {
		ids[i] = z.Member.(string)
	}
	names, err := l.rdb.HMGet(ctx, namesKey, ids...).Result()
	if err != nil {
		return nil, err
	}
	out := make([]cache.Entry, len(zs))
	for i, z := range zs {
		name := ""
		if s, ok := names[i].(string); ok {
			name = s
		}
		out[i] = cache.Entry{Rank: startRank + int64(i), PlayerID: ids[i], Name: name, Score: int64(z.Score)}
	}
	return out, nil
}

func (l *lb) Top(ctx context.Context, eventID string, limit int) ([]cache.Entry, error) {
	if limit <= 0 {
		limit = 100
	}
	zs, err := l.rdb.ZRevRangeWithScores(ctx, lbKey(eventID), 0, int64(limit-1)).Result()
	if err != nil {
		return nil, err
	}
	return l.hydrate(ctx, zs, 1)
}

func (l *lb) Rank(ctx context.Context, eventID, playerID string) (int64, int64, bool, error) {
	rank, err := l.rdb.ZRevRank(ctx, lbKey(eventID), playerID).Result()
	if errors.Is(err, goredis.Nil) {
		return 0, 0, false, nil
	}
	if err != nil {
		return 0, 0, false, err
	}
	score, err := l.rdb.ZScore(ctx, lbKey(eventID), playerID).Result()
	if err != nil {
		return 0, 0, false, err
	}
	return rank + 1, int64(score), true, nil
}

func (l *lb) Around(ctx context.Context, eventID, playerID string, radius int) ([]cache.Entry, error) {
	rank, err := l.rdb.ZRevRank(ctx, lbKey(eventID), playerID).Result()
	if errors.Is(err, goredis.Nil) {
		return []cache.Entry{}, nil
	}
	if err != nil {
		return nil, err
	}
	lo := max(0, rank-int64(radius))
	hi := rank + int64(radius)
	zs, err := l.rdb.ZRevRangeWithScores(ctx, lbKey(eventID), lo, hi).Result()
	if err != nil {
		return nil, err
	}
	return l.hydrate(ctx, zs, lo+1)
}

func (l *lb) Count(ctx context.Context, eventID string) (int64, error) {
	return l.rdb.ZCard(ctx, lbKey(eventID)).Result()
}

// ---- analytics ----

type an Cache

func anKey(eventID string) string { return "an:" + eventID }

func (a *an) IncrMany(ctx context.Context, eventID string, fields map[string]int64) error {
	if len(fields) == 0 {
		return nil
	}
	pipe := a.rdb.TxPipeline()
	for f, n := range fields {
		pipe.HIncrBy(ctx, anKey(eventID), f, n)
	}
	pipe.Expire(ctx, anKey(eventID), 30*24*time.Hour)
	_, err := pipe.Exec(ctx)
	return err
}

func (a *an) AddUnique(ctx context.Context, eventID, set, member string) (bool, error) {
	k := anKey(eventID) + ":set:" + set
	n, err := a.rdb.SAdd(ctx, k, member).Result()
	if err != nil {
		return false, err
	}
	if n > 0 {
		a.rdb.Expire(ctx, k, 30*24*time.Hour)
	}
	return n > 0, nil
}

func (a *an) Snapshot(ctx context.Context, eventID string) (map[string]int64, error) {
	raw, err := a.rdb.HGetAll(ctx, anKey(eventID)).Result()
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(raw))
	for k, v := range raw {
		n, _ := strconv.ParseInt(v, 10, 64)
		out[k] = n
	}
	return out, nil
}

// ---- rate limiter ----

type rl Cache

// tokenBucket is evaluated atomically in Redis. KEYS[1]=bucket, ARGV: limit,
// refill per ms, now ms. Returns {allowed, retryAfterMs}.
var tokenBucket = goredis.NewScript(`
local limit = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1])
local ts = tonumber(b[2])
if tokens == nil then tokens = limit; ts = now end
local elapsed = math.max(0, now - ts)
tokens = math.min(limit, tokens + elapsed * rate)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(limit / rate) * 2)
return {allowed, retry}
`)

func (r *rl) Allow(ctx context.Context, key string, limit int, window time.Duration) (bool, time.Duration, error) {
	rate := float64(limit) / float64(window.Milliseconds())
	res, err := tokenBucket.Run(ctx, r.rdb, []string{key}, limit, rate, time.Now().UnixMilli()).Slice()
	if err != nil {
		return false, 0, err
	}
	allowed, _ := res[0].(int64)
	retry, _ := res[1].(int64)
	return allowed == 1, time.Duration(retry) * time.Millisecond, nil
}

// ---- kv ----

type kv Cache

func (k *kv) Get(ctx context.Context, key string) ([]byte, bool, error) {
	b, err := k.rdb.Get(ctx, key).Bytes()
	if errors.Is(err, goredis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

func (k *kv) Set(ctx context.Context, key string, val []byte, ttl time.Duration) error {
	return k.rdb.Set(ctx, key, val, ttl).Err()
}

func (k *kv) Del(ctx context.Context, key string) error {
	return k.rdb.Del(ctx, key).Err()
}
