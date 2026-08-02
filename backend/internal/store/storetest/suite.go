// Package storetest is a conformance suite every store.Store adapter must
// pass. The in-memory adapter runs it as a unit test; the DynamoDB adapter
// runs it as an integration test against DynamoDB Local. Passing the same
// suite is what lets services be tested against memory with confidence.
package storetest

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/ids"
	"github.com/atakank/vault-rush/backend/internal/store"
	"github.com/atakank/vault-rush/backend/pkg/engine"
)

// Run executes the suite.
func Run(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()

	t.Run("players/create-get-device-uniqueness", func(t *testing.T) {
		p := newPlayer("dev-" + ids.New("d"))
		if err := st.Players().Create(ctx, p); err != nil {
			t.Fatal(err)
		}
		if err := st.Players().Create(ctx, p); !errors.Is(err, domain.ErrAlreadyExists) {
			t.Fatalf("duplicate id should fail with ErrAlreadyExists, got %v", err)
		}
		dup := newPlayer(p.DeviceID)
		if err := st.Players().Create(ctx, dup); !errors.Is(err, domain.ErrAlreadyExists) {
			t.Fatalf("duplicate device should fail with ErrAlreadyExists, got %v", err)
		}
		got, err := st.Players().Get(ctx, p.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.DisplayName != p.DisplayName || got.Coins != p.Coins || got.Version != 1 {
			t.Fatalf("round trip mismatch: %+v", got)
		}
		byDev, err := st.Players().GetByDevice(ctx, p.DeviceID)
		if err != nil || byDev.ID != p.ID {
			t.Fatalf("GetByDevice: %v %+v", err, byDev)
		}
		if _, err := st.Players().Get(ctx, "plr_missing"); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("missing player should be ErrNotFound, got %v", err)
		}
	})

	t.Run("players/optimistic-concurrency", func(t *testing.T) {
		p := newPlayer("dev-" + ids.New("d"))
		if err := st.Players().Create(ctx, p); err != nil {
			t.Fatal(err)
		}
		a, _ := st.Players().Get(ctx, p.ID)
		b, _ := st.Players().Get(ctx, p.ID)
		a.Coins += 10
		if err := st.Players().Update(ctx, a); err != nil {
			t.Fatal(err)
		}
		if a.Version != 2 {
			t.Fatalf("version should bump to 2, got %d", a.Version)
		}
		b.Coins += 20
		if err := st.Players().Update(ctx, b); !errors.Is(err, domain.ErrVersionConflict) {
			t.Fatalf("stale write must fail with ErrVersionConflict, got %v", err)
		}
		got, _ := st.Players().Get(ctx, p.ID)
		if got.Coins != p.Coins+10 {
			t.Fatalf("lost update: coins=%d", got.Coins)
		}

		// Many writers, each wants +1: with read-modify-write retries the total is exact.
		var wg sync.WaitGroup
		var conflicts int64
		var mu sync.Mutex
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					cur, err := st.Players().Get(ctx, p.ID)
					if err != nil {
						t.Error(err)
						return
					}
					cur.Coins++
					err = st.Players().Update(ctx, cur)
					if err == nil {
						return
					}
					if !errors.Is(err, domain.ErrVersionConflict) {
						t.Error(err)
						return
					}
					mu.Lock()
					conflicts++
					mu.Unlock()
				}
			}()
		}
		wg.Wait()
		got, _ = st.Players().Get(ctx, p.ID)
		if got.Coins != p.Coins+10+20 {
			t.Fatalf("expected exactly +20, got %d (conflicts=%d)", got.Coins-p.Coins-10, conflicts)
		}
	})

	t.Run("runs/finish-exactly-once", func(t *testing.T) {
		p := newPlayer("dev-" + ids.New("d"))
		_ = st.Players().Create(ctx, p)
		run := &domain.Run{ID: ids.New("run"), PlayerID: p.ID, EventID: "ev", Seed: 42, ConfigVersion: 1, Boosters: []string{}, Status: domain.RunActive, StartedAt: time.Now().UTC(), ExpiresAt: time.Now().Add(time.Hour).UTC()}
		if err := st.Runs().Put(ctx, run); err != nil {
			t.Fatal(err)
		}
		got, err := st.Runs().Get(ctx, p.ID, run.ID)
		if err != nil || got.Seed != 42 || got.Status != domain.RunActive {
			t.Fatalf("run round trip: %v %+v", err, got)
		}
		if _, err := st.Runs().Get(ctx, "someone-else", run.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("run keyed by owner must be invisible to others, got %v", err)
		}
		var wg sync.WaitGroup
		var wins int64
		var mu sync.Mutex
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				r := *got
				r.Result = &engine.Result{Score: 100}
				if err := st.Runs().Finish(ctx, &r); err == nil {
					mu.Lock()
					wins++
					mu.Unlock()
				} else if !errors.Is(err, domain.ErrConflict) {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
		if wins != 1 {
			t.Fatalf("exactly one finish must win, got %d", wins)
		}
		list, err := st.Runs().ListByPlayer(ctx, p.ID, 10)
		if err != nil || len(list) != 1 || list[0].Status != domain.RunFinished {
			t.Fatalf("ListByPlayer: %v %+v", err, list)
		}
	})

	t.Run("events/config-versions-immutable", func(t *testing.T) {
		id := "ev_" + ids.New("x")
		now := time.Now().UTC().Truncate(time.Second)
		meta := &domain.EventMeta{ID: id, Name: "Test", Theme: "louvre", StartsAt: now, EndsAt: now.Add(24 * time.Hour), ConfigVersion: 1, CreatedAt: now, UpdatedAt: now}
		if err := st.Events().CreateMeta(ctx, meta); err != nil {
			t.Fatal(err)
		}
		if err := st.Events().CreateMeta(ctx, meta); !errors.Is(err, domain.ErrAlreadyExists) {
			t.Fatalf("duplicate event must fail, got %v", err)
		}
		cfg := engine.DefaultConfig(id, 7, now)
		if err := st.Events().PutConfig(ctx, &cfg); err != nil {
			t.Fatal(err)
		}
		if err := st.Events().PutConfig(ctx, &cfg); !errors.Is(err, domain.ErrAlreadyExists) {
			t.Fatalf("config version must be immutable, got %v", err)
		}
		v2 := cfg
		v2.Version = 2
		v2.Difficulty = 1.5
		v2.Note = "harder"
		if err := st.Events().PutConfig(ctx, &v2); err != nil {
			t.Fatal(err)
		}
		got1, err := st.Events().GetConfig(ctx, id, 1)
		if err != nil || got1.Difficulty != 1.0 {
			t.Fatalf("v1 must be untouched: %v %+v", err, got1)
		}
		got2, _ := st.Events().GetConfig(ctx, id, 2)
		if got2.Difficulty != 1.5 || len(got2.Vaults) != 5 {
			t.Fatalf("v2 mismatch: %+v", got2)
		}
		versions, err := st.Events().ListConfigVersions(ctx, id)
		if err != nil || len(versions) != 2 || versions[0].Version != 2 || versions[0].Note != "harder" {
			t.Fatalf("versions: %v %+v", err, versions)
		}
		meta.ConfigVersion = 2
		if err := st.Events().UpdateMeta(ctx, meta); err != nil {
			t.Fatal(err)
		}
		gotMeta, _ := st.Events().GetMeta(ctx, id)
		if gotMeta.ConfigVersion != 2 {
			t.Fatalf("meta pointer not updated: %+v", gotMeta)
		}
		list, err := st.Events().ListMeta(ctx, now.Add(-time.Hour), now.Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, m := range list {
			if m.ID == id {
				found = true
			}
		}
		if !found {
			t.Fatalf("ListMeta should include the active event")
		}
		if _, err := st.Events().GetConfig(ctx, id, 99); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("missing version should be ErrNotFound, got %v", err)
		}
	})

	t.Run("rewards/claim-exactly-once", func(t *testing.T) {
		p := newPlayer("dev-" + ids.New("d"))
		_ = st.Players().Create(ctx, p)
		rw := &domain.Reward{ID: ids.New("rwd"), PlayerID: p.ID, Type: domain.RewardTypeRunLoot, Coins: 100, Status: domain.RewardPending, CreatedAt: time.Now().UTC()}
		if err := st.Rewards().Create(ctx, rw); err != nil {
			t.Fatal(err)
		}
		if err := st.Rewards().Create(ctx, rw); !errors.Is(err, domain.ErrAlreadyExists) {
			t.Fatalf("second Create must fail with ErrAlreadyExists, got %v", err)
		}
		if err := st.Rewards().Put(ctx, rw); err != nil {
			t.Fatal(err)
		}
		pending, err := st.Rewards().ListPending(ctx, p.ID)
		if err != nil || len(pending) != 1 {
			t.Fatalf("ListPending: %v %+v", err, pending)
		}
		var wg sync.WaitGroup
		var wins, conflicts int64
		var mu sync.Mutex
		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := st.Rewards().Claim(ctx, p.ID, rw.ID, time.Now().UTC())
				mu.Lock()
				defer mu.Unlock()
				switch {
				case err == nil:
					wins++
				case errors.Is(err, domain.ErrConflict):
					conflicts++
				default:
					t.Error(err)
				}
			}()
		}
		wg.Wait()
		if wins != 1 || conflicts != 99 {
			t.Fatalf("100 concurrent claims: wins=%d conflicts=%d (want 1/99)", wins, conflicts)
		}
		pending, _ = st.Rewards().ListPending(ctx, p.ID)
		if len(pending) != 0 {
			t.Fatalf("claimed reward still pending")
		}
		if _, err := st.Rewards().Claim(ctx, p.ID, "rwd_missing", time.Now()); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("missing reward should be ErrNotFound, got %v", err)
		}
	})

	t.Run("idempotency/begin-complete-replay", func(t *testing.T) {
		pid := ids.New("plr")
		key := ids.New("k")
		rec, acquired, err := st.Idempotency().Begin(ctx, pid, key, time.Hour)
		if err != nil || !acquired || rec.State != domain.IdempotencyInProgress {
			t.Fatalf("first begin: %v %v %+v", err, acquired, rec)
		}
		rec2, acquired2, err := st.Idempotency().Begin(ctx, pid, key, time.Hour)
		if err != nil || acquired2 || rec2.State != domain.IdempotencyInProgress {
			t.Fatalf("second begin must not acquire: %v %v %+v", err, acquired2, rec2)
		}
		if err := st.Idempotency().Complete(ctx, pid, key, 200, []byte(`{"ok":true}`)); err != nil {
			t.Fatal(err)
		}
		rec3, acquired3, _ := st.Idempotency().Begin(ctx, pid, key, time.Hour)
		if acquired3 || rec3.State != domain.IdempotencyDone || rec3.StatusCode != 200 || string(rec3.Body) != `{"ok":true}` {
			t.Fatalf("replay record mismatch: %v %+v", acquired3, rec3)
		}
		// Same key, different player → independent.
		if _, acq, _ := st.Idempotency().Begin(ctx, ids.New("plr"), key, time.Hour); !acq {
			t.Fatal("idempotency keys must be scoped per player")
		}
		if err := st.Idempotency().Abort(ctx, pid, key); err != nil {
			t.Fatal(err)
		}
		if _, acq, _ := st.Idempotency().Begin(ctx, pid, key, time.Hour); !acq {
			t.Fatal("aborted key must be reusable")
		}
	})
}

func newPlayer(device string) *domain.Player {
	now := time.Now().UTC()
	return &domain.Player{
		ID: ids.New("plr"), DeviceID: device, DisplayName: "Tester", Coins: 1000, Lives: 5, MaxLives: 5,
		Boosters: map[string]int{}, ExperimentGroup: "A", Version: 1, CreatedAt: now, UpdatedAt: now, LivesUpdatedAt: now,
	}
}
