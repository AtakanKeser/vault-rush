// Package cachetest is the conformance suite for cache.Cache adapters (memory
// and Redis).
package cachetest

import (
	"context"
	"testing"
	"time"

	"github.com/atakank/vault-rush/backend/internal/cache"
	"github.com/atakank/vault-rush/backend/internal/ids"
)

// Run executes the suite.
func Run(t *testing.T, c cache.Cache) {
	t.Helper()
	ctx := context.Background()

	t.Run("leaderboard/ordering-rank-around", func(t *testing.T) {
		ev := "ev_" + ids.New("x")
		lb := c.Leaderboard()
		must(t, lb.Submit(ctx, ev, "p1", "One", 100))
		must(t, lb.Submit(ctx, ev, "p2", "Two", 300))
		must(t, lb.Submit(ctx, ev, "p3", "Three", 200))
		must(t, lb.Submit(ctx, ev, "p4", "Four", 50))
		must(t, lb.Submit(ctx, ev, "p2", "Two", 250)) // lower score must not overwrite (GT)
		must(t, lb.Submit(ctx, ev, "p1", "One", 400)) // higher score must

		top, err := lb.Top(ctx, ev, 3)
		must(t, err)
		if len(top) != 3 || top[0].PlayerID != "p1" || top[0].Score != 400 || top[1].PlayerID != "p2" || top[1].Score != 300 || top[2].PlayerID != "p3" {
			t.Fatalf("unexpected top: %+v", top)
		}
		if top[0].Rank != 1 || top[2].Rank != 3 || top[0].Name != "One" {
			t.Fatalf("ranks/names not hydrated: %+v", top)
		}
		rank, score, found, err := lb.Rank(ctx, ev, "p3")
		must(t, err)
		if !found || rank != 3 || score != 200 {
			t.Fatalf("rank p3 = %d/%d/%v", rank, score, found)
		}
		if _, _, found, _ := lb.Rank(ctx, ev, "nobody"); found {
			t.Fatal("unknown player must not be found")
		}
		n, err := lb.Count(ctx, ev)
		must(t, err)
		if n != 4 {
			t.Fatalf("count = %d", n)
		}
		around, err := lb.Around(ctx, ev, "p3", 1)
		must(t, err)
		if len(around) != 3 || around[0].PlayerID != "p2" || around[1].PlayerID != "p3" || around[2].PlayerID != "p4" || around[1].Rank != 3 {
			t.Fatalf("around p3: %+v", around)
		}
		empty, err := lb.Around(ctx, ev, "nobody", 2)
		must(t, err)
		if len(empty) != 0 {
			t.Fatalf("around unknown should be empty, got %+v", empty)
		}
	})

	t.Run("analytics/counters-and-unique-sets", func(t *testing.T) {
		ev := "ev_" + ids.New("x")
		an := c.Analytics()
		must(t, an.IncrMany(ctx, ev, map[string]int64{"runsStarted": 1, "scoreSum": 500}))
		must(t, an.IncrMany(ctx, ev, map[string]int64{"runsStarted": 2, "scoreSum": 250}))
		isNew, err := an.AddUnique(ctx, ev, "players", "p1")
		must(t, err)
		again, _ := an.AddUnique(ctx, ev, "players", "p1")
		other, _ := an.AddUnique(ctx, ev, "players", "p2")
		if !isNew || again || !other {
			t.Fatalf("unique set semantics broken: %v %v %v", isNew, again, other)
		}
		snap, err := an.Snapshot(ctx, ev)
		must(t, err)
		if snap["runsStarted"] != 3 || snap["scoreSum"] != 750 {
			t.Fatalf("snapshot = %v", snap)
		}
	})

	t.Run("ratelimiter/token-bucket", func(t *testing.T) {
		rl := c.RateLimiter()
		key := "rl:" + ids.New("k")
		allowed := 0
		for i := 0; i < 12; i++ {
			ok, _, err := rl.Allow(ctx, key, 10, time.Minute)
			must(t, err)
			if ok {
				allowed++
			}
		}
		if allowed != 10 {
			t.Fatalf("burst of 10 expected, got %d", allowed)
		}
		ok, retry, err := rl.Allow(ctx, key, 10, time.Minute)
		must(t, err)
		if ok || retry <= 0 || retry > 7*time.Second {
			t.Fatalf("expected denial with ~6s retry, got ok=%v retry=%v", ok, retry)
		}
		// Independent key is unaffected.
		if ok, _, _ := rl.Allow(ctx, "rl:"+ids.New("k"), 10, time.Minute); !ok {
			t.Fatal("independent bucket must allow")
		}
	})

	t.Run("kv/ttl", func(t *testing.T) {
		kv := c.KV()
		key := "kv:" + ids.New("k")
		if _, hit, err := kv.Get(ctx, key); err != nil || hit {
			t.Fatalf("empty key: %v %v", err, hit)
		}
		must(t, kv.Set(ctx, key, []byte("v1"), time.Minute))
		v, hit, err := kv.Get(ctx, key)
		must(t, err)
		if !hit || string(v) != "v1" {
			t.Fatalf("get = %q %v", v, hit)
		}
		must(t, kv.Del(ctx, key))
		if _, hit, _ := kv.Get(ctx, key); hit {
			t.Fatal("deleted key still present")
		}
		must(t, kv.Set(ctx, key, []byte("short"), 50*time.Millisecond))
		time.Sleep(120 * time.Millisecond)
		if _, hit, _ := kv.Get(ctx, key); hit {
			t.Fatal("expired key still present")
		}
	})
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
