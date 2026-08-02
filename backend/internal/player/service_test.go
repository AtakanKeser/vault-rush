package player

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/atakank/vault-rush/backend/internal/auth"
	"github.com/atakank/vault-rush/backend/internal/domain"
	storemem "github.com/atakank/vault-rush/backend/internal/store/memory"
)

func TestCreateOrResumeIsIdempotentPerDevice(t *testing.T) {
	svc := New(storemem.New(), auth.New("s", 0), nil, 30*time.Minute)
	ctx := context.Background()
	a, tokA, created, err := svc.CreateOrResume(ctx, "device-1", "Atakan")
	if err != nil || !created || tokA == "" {
		t.Fatalf("create: %v %v", err, created)
	}
	b, _, created2, err := svc.CreateOrResume(ctx, "device-1", "Other Name")
	if err != nil || created2 || b.ID != a.ID || b.DisplayName != "Atakan" {
		t.Fatalf("resume: %v %v %+v", err, created2, b)
	}
	if a.Coins != StartingCoins || a.Lives != a.MaxLives || a.ExperimentGroup == "" {
		t.Fatalf("defaults: %+v", a)
	}
	if _, _, _, err := svc.CreateOrResume(ctx, "  ", "x"); err == nil {
		t.Fatal("empty device id must fail")
	}
}

func TestLifeRegeneration(t *testing.T) {
	regen := 30 * time.Minute
	base := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	p := &domain.Player{Lives: 2, MaxLives: 5, LivesUpdatedAt: base}

	ApplyRegen(p, base.Add(10*time.Minute), regen)
	if p.Lives != 2 {
		t.Fatalf("no life yet, got %d", p.Lives)
	}
	ApplyRegen(p, base.Add(65*time.Minute), regen)
	if p.Lives != 4 || !p.LivesUpdatedAt.Equal(base.Add(60*time.Minute)) {
		t.Fatalf("two lives after 65m, got %d at %s", p.Lives, p.LivesUpdatedAt)
	}
	ApplyRegen(p, base.Add(10*time.Hour), regen)
	if p.Lives != 5 || !p.LivesUpdatedAt.Equal(base.Add(10*time.Hour)) {
		t.Fatalf("capped at max with clock reset, got %d at %s", p.Lives, p.LivesUpdatedAt)
	}

	svc := New(storemem.New(), auth.New("s", 0), nil, regen)
	now := base
	svc.WithClock(func() time.Time { return now })
	created, _, _, _ := svc.CreateOrResume(context.Background(), "d", "n")
	view := svc.View(created)
	if view.NextLifeAt != nil {
		t.Fatal("full lives → no nextLifeAt")
	}
	_, _ = svc.Mutate(context.Background(), created.ID, func(p *domain.Player) error { p.Lives = 1; p.LivesUpdatedAt = now; return nil })
	got, _ := svc.Get(context.Background(), created.ID)
	view = svc.View(got)
	if view.NextLifeAt == nil || !view.NextLifeAt.Equal(base.Add(regen)) {
		t.Fatalf("nextLifeAt = %v", view.NextLifeAt)
	}
}

func TestMutateRetriesOnConflictAndNeverLosesUpdates(t *testing.T) {
	svc := New(storemem.New(), auth.New("s", 0), nil, 30*time.Minute)
	ctx := context.Background()
	p, _, _, _ := svc.CreateOrResume(ctx, "d", "n")
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				_, err := svc.Mutate(ctx, p.ID, func(p *domain.Player) error { p.Coins++; return nil })
				if err == nil {
					return
				}
			}
		}()
	}
	wg.Wait()
	got, _ := svc.Get(ctx, p.ID)
	if got.Coins != StartingCoins+50 {
		t.Fatalf("lost updates: coins=%d want %d", got.Coins, StartingCoins+50)
	}
}
