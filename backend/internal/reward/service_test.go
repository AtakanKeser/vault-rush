package reward

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/atakank/vault-rush/backend/internal/auth"
	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/player"
	storemem "github.com/atakank/vault-rush/backend/internal/store/memory"
)

func setup(t *testing.T) (*Service, *player.Service, *domain.Player) {
	t.Helper()
	st := storemem.New()
	players := player.New(st, auth.New("secret", 0), nil, 30*time.Minute)
	p, _, _, err := players.CreateOrResume(context.Background(), "dev-1", "Tester")
	if err != nil {
		t.Fatal(err)
	}
	return New(st, players, nil, nil), players, p
}

// TestConcurrentClaimGrantsExactlyOnce is the headline property: 100
// goroutines race to claim the same reward and the player is paid once.
func TestConcurrentClaimGrantsExactlyOnce(t *testing.T) {
	svc, players, p := setup(t)
	ctx := context.Background()
	run := &domain.Run{ID: "run_1", PlayerID: p.ID, EventID: "ev"}
	rw, err := svc.GrantRunLoot(ctx, run, 18420)
	if err != nil {
		t.Fatal(err)
	}
	if rw.Coins != 184 {
		t.Fatalf("18420 score → 184 coins, got %d", rw.Coins)
	}
	before, _ := players.Get(ctx, p.ID)

	var wg sync.WaitGroup
	var wins, conflicts int64
	var mu sync.Mutex
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := svc.Claim(ctx, p.ID, rw.ID)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				wins++
			case errors.Is(err, ErrAlreadyClaimed):
				conflicts++
			default:
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	wg.Wait()
	if wins != 1 || conflicts != 99 {
		t.Fatalf("wins=%d conflicts=%d, want 1/99", wins, conflicts)
	}
	after, _ := players.Get(ctx, p.ID)
	if after.Coins != before.Coins+184 {
		t.Fatalf("coins credited %d times", (after.Coins-before.Coins)/184)
	}
	pending, _ := svc.ListPending(ctx, p.ID)
	if len(pending) != 0 {
		t.Fatalf("reward still pending after claim")
	}
}

func TestGrantRunLootIsIdempotent(t *testing.T) {
	svc, _, p := setup(t)
	ctx := context.Background()
	run := &domain.Run{ID: "run_2", PlayerID: p.ID, EventID: "ev"}
	a, _ := svc.GrantRunLoot(ctx, run, 5000)
	b, _ := svc.GrantRunLoot(ctx, run, 5000)
	if a.ID != b.ID {
		t.Fatalf("re-grant produced a new reward: %s vs %s", a.ID, b.ID)
	}
	pending, _ := svc.ListPending(ctx, p.ID)
	if len(pending) != 1 {
		t.Fatalf("expected exactly one pending reward, got %d", len(pending))
	}
}

func TestLeaderboardPayoutTable(t *testing.T) {
	cases := map[int64]int64{1: 5000, 2: 3000, 3: 3000, 4: 1500, 10: 1500, 11: 500, 100: 500, 101: 0}
	for rank, want := range cases {
		if got := LeaderboardCoins(rank); got != want {
			t.Errorf("rank %d: got %d want %d", rank, got, want)
		}
	}
	if RunLootCoins(50) != 10 {
		t.Error("minimum run reward should be 10 coins")
	}
}

func TestClaimUnknownRewardIsNotFound(t *testing.T) {
	svc, _, p := setup(t)
	if _, _, err := svc.Claim(context.Background(), p.ID, "rwd_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}
