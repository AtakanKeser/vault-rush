package liveops

import (
	"context"
	"errors"
	"testing"
	"time"

	cachemem "github.com/atakank/vault-rush/backend/internal/cache/memory"
	"github.com/atakank/vault-rush/backend/internal/domain"
	storemem "github.com/atakank/vault-rush/backend/internal/store/memory"
	"github.com/atakank/vault-rush/backend/pkg/engine"
)

func newSvc(now time.Time) *Service {
	svc := New(storemem.New(), cachemem.New().KV(), "salt")
	svc.WithClock(func() time.Time { return now })
	return svc
}

func TestDailyIDAndSeedAreDeterministic(t *testing.T) {
	day := time.Date(2026, 9, 7, 15, 0, 0, 0, time.UTC)
	id1, theme := DailyID(day)
	id2, _ := DailyID(day.Add(3 * time.Hour))
	if id1 != id2 || theme.ID == "" || id1 != theme.ID+"_2026_09_07" {
		t.Fatalf("daily id: %s %s %+v", id1, id2, theme)
	}
	next, _ := DailyID(day.AddDate(0, 0, 1))
	if next == id1 {
		t.Fatal("next day must have a different id")
	}
	svc, other := newSvc(day), newSvc(day.Add(time.Hour))
	if svc.Seed(id1) != other.Seed(id1) || svc.Seed(id1) == svc.Seed(next) {
		t.Fatal("seed must be stable per event and differ between events")
	}
}

func TestCurrentProvisionsOnceAndPinsVersions(t *testing.T) {
	now := time.Date(2026, 9, 7, 15, 0, 0, 0, time.UTC)
	svc := newSvc(now)
	ctx := context.Background()

	meta, cfg, err := svc.Current(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if meta.StatusAt(now) != domain.EventActive || cfg.Version != 1 || meta.ConfigVersion != 1 {
		t.Fatalf("fresh event: %+v v%d", meta, cfg.Version)
	}
	if !meta.StartsAt.Equal(time.Date(2026, 9, 7, 0, 0, 0, 0, time.UTC)) || !meta.EndsAt.Equal(time.Date(2026, 9, 8, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("window: %s → %s", meta.StartsAt, meta.EndsAt)
	}
	again, _, _ := svc.Current(ctx)
	if again.ID != meta.ID || again.CreatedAt != meta.CreatedAt {
		t.Fatal("second call must not re-provision")
	}

	// Publish v2: pointer moves, v1 stays readable and unchanged.
	newCfg := *cfg
	newCfg.Difficulty = 1.25
	meta2, cfg2, err := svc.PublishConfig(ctx, meta.ID, newCfg, "harder", "atakan")
	if err != nil {
		t.Fatal(err)
	}
	if meta2.ConfigVersion != 2 || cfg2.Version != 2 || cfg2.Note != "harder" || cfg2.CreatedBy != "atakan" {
		t.Fatalf("publish: %+v %+v", meta2, cfg2)
	}
	v1, err := svc.GetConfig(ctx, meta.ID, 1)
	if err != nil || v1.Difficulty != 1.0 {
		t.Fatalf("v1 must be intact: %v %+v", err, v1)
	}
	cur, curCfg, _ := svc.Current(ctx)
	if cur.ConfigVersion != 2 || curCfg.Difficulty != 1.25 {
		t.Fatalf("current must serve v2: %+v", curCfg)
	}
	versions, _ := svc.Versions(ctx, meta.ID)
	if len(versions) != 2 || versions[0].Version != 2 {
		t.Fatalf("versions: %+v", versions)
	}

	// Invalid config is rejected before anything is written.
	bad := *cfg
	bad.Vaults = []engine.Vault{{Moves: 10, Objectives: engine.Objectives{Key: 5}, Weights: engine.Weights{Money: 1}}} // unwinnable
	bad.VaultMultipliers = []float64{1}
	if _, _, err := svc.PublishConfig(ctx, meta.ID, bad, "oops", "x"); !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation, got %v", err)
	}
	if m, _ := svc.GetMeta(ctx, meta.ID); m.ConfigVersion != 2 {
		t.Fatal("failed publish must not move the pointer")
	}
}

func TestListWindowProvisionsSurroundingDays(t *testing.T) {
	now := time.Date(2026, 9, 7, 15, 0, 0, 0, time.UTC)
	svc := newSvc(now)
	list, err := svc.ListWindow(context.Background(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 4 { // yesterday, today, +1, +2
		t.Fatalf("expected 4 events, got %d", len(list))
	}
	if list[0].StatusAt(now) != domain.EventEnded || list[1].StatusAt(now) != domain.EventActive || list[2].StatusAt(now) != domain.EventUpcoming {
		t.Fatalf("statuses: %s %s %s", list[0].StatusAt(now), list[1].StatusAt(now), list[2].StatusAt(now))
	}
	ended, _ := svc.EndedUndistributed(context.Background(), 48*time.Hour)
	if len(ended) != 1 || ended[0].ID != list[0].ID {
		t.Fatalf("ended undistributed: %+v", ended)
	}
}
