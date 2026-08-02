package shop

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

func setup(t *testing.T, coins int64) (*Service, *player.Service, string) {
	t.Helper()
	st := storemem.New()
	players := player.New(st, auth.New("secret", 0), nil, 30*time.Minute)
	p, _, _, err := players.CreateOrResume(context.Background(), "dev-1", "Buyer")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := players.Mutate(context.Background(), p.ID, func(p *domain.Player) error { p.Coins = coins; return nil }); err != nil {
		t.Fatal(err)
	}
	return New(players, nil), players, p.ID
}

// TestConcurrentPurchasesNeverOverspend: 1000 coins, two simultaneous 700-coin
// purchases (shield=450 + extra_moves=300 = 750 fits; two shields = 900 fits;
// so use a custom expensive item scenario via many parallel buys).
func TestConcurrentPurchasesNeverOverspend(t *testing.T) {
	svc, players, pid := setup(t, 1000)
	ctx := context.Background()

	// 50 goroutines each try to buy a 300-coin booster: only 3 can succeed.
	var wg sync.WaitGroup
	var ok, broke int64
	var mu sync.Mutex
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := svc.Purchase(ctx, pid, "extra_moves")
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				ok++
			case errors.Is(err, ErrInsufficientCoins):
				broke++
			default:
				t.Errorf("unexpected: %v", err)
			}
		}()
	}
	wg.Wait()
	p, _ := players.Get(ctx, pid)
	if ok != 3 || p.Coins != 100 || p.Boosters["extra_moves"] != 1+3 {
		t.Fatalf("ok=%d broke=%d coins=%d boosters=%v — overspend or lost update", ok, broke, p.Coins, p.Boosters)
	}
}

func TestPurchaseTwoItemsThatTogetherExceedBalance(t *testing.T) {
	svc, players, pid := setup(t, 700)
	ctx := context.Background()
	var wg sync.WaitGroup
	results := make([]error, 2)
	for i, item := range []string{"shield", "extra_moves"} { // 450 + 300 > 700
		wg.Add(1)
		go func(i int, item string) {
			defer wg.Done()
			_, results[i] = svc.Purchase(ctx, pid, item)
		}(i, item)
	}
	wg.Wait()
	succeeded := 0
	for _, err := range results {
		if err == nil {
			succeeded++
		} else if !errors.Is(err, ErrInsufficientCoins) {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	p, _ := players.Get(ctx, pid)
	if succeeded != 1 || p.Coins < 0 {
		t.Fatalf("exactly one purchase must win; succeeded=%d coins=%d", succeeded, p.Coins)
	}
}

func TestPurchaseValidation(t *testing.T) {
	svc, _, pid := setup(t, 10_000)
	ctx := context.Background()
	if _, err := svc.Purchase(ctx, pid, "jetpack"); !errors.Is(err, ErrUnknownItem) {
		t.Fatalf("unknown item: %v", err)
	}
	if _, err := svc.Purchase(ctx, pid, "life"); !errors.Is(err, ErrLivesFull) {
		t.Fatalf("full lives: %v", err)
	}
}
