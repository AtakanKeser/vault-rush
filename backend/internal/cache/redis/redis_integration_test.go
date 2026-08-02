//go:build integration

package redis

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/atakank/vault-rush/backend/internal/cache/cachetest"
)

// Runs against a real Redis:
//
//	REDIS_ADDR=localhost:6379 go test -tags=integration ./internal/cache/redis/
func TestConformanceRedis(t *testing.T) {
	addr := os.Getenv("REDIS_ADDR")
	if addr == "" {
		t.Skip("REDIS_ADDR not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := New(ctx, addr, os.Getenv("REDIS_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	cachetest.Run(t, c)
}
