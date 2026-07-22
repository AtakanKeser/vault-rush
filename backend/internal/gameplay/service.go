// Package gameplay starts and settles heist runs.
//
// The finish path is the latency-sensitive core of the platform: validate,
// replay deterministically, persist the authoritative result, hand the player
// their reward, and push everything else (leaderboard, analytics) onto the
// asynchronous telemetry bus.
package gameplay

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/ids"
	"github.com/atakank/vault-rush/backend/internal/liveops"
	"github.com/atakank/vault-rush/backend/internal/player"
	"github.com/atakank/vault-rush/backend/internal/reward"
	"github.com/atakank/vault-rush/backend/internal/store"
	"github.com/atakank/vault-rush/backend/internal/telemetry"
	"github.com/atakank/vault-rush/backend/pkg/engine"
)

// Domain errors surfaced to the API layer.
var (
	ErrEventClosed          = errors.New("event is not active")
	ErrInsufficientLives    = errors.New("not enough lives")
	ErrInsufficientBoosters = errors.New("booster not in inventory")
	ErrUnknownBooster       = errors.New("unknown booster")
	ErrRunExpired           = errors.New("run expired")
	ErrRunFinished          = errors.New("run already finished")
	ErrForbidden            = errors.New("run belongs to another player")
	ErrScoreMismatch        = errors.New("client score does not match server replay")
	ErrImplausible          = errors.New("result failed plausibility checks")
)

// Service is the gameplay service.
type Service struct {
	store   store.Store
	players *player.Service
	live    *liveops.Service
	rewards *reward.Service
	bus     *telemetry.Bus
	runTTL  time.Duration
	log     *slog.Logger
	now     func() time.Time
}

// New wires the service.
func New(st store.Store, players *player.Service, live *liveops.Service, rewards *reward.Service, bus *telemetry.Bus, runTTL time.Duration, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	if runTTL <= 0 {
		runTTL = 2 * time.Hour
	}
	return &Service{store: st, players: players, live: live, rewards: rewards, bus: bus, runTTL: runTTL, log: log, now: func() time.Time { return time.Now().UTC() }}
}

// WithClock overrides the clock (tests).
func (s *Service) WithClock(now func() time.Time) *Service { s.now = now; return s }

// StartResult is returned to the client so it can build the board offline.
type StartResult struct {
	Run    *domain.Run
	Config *engine.Config
}

// Start charges lives and boosters, then creates the run record.
func (s *Service) Start(ctx context.Context, playerID string, boosters []string) (*StartResult, error) {
	meta, cfg, err := s.live.Current(ctx)
	if err != nil {
		return nil, err
	}
	now := s.now()
	if meta.StatusAt(now) != domain.EventActive {
		return nil, ErrEventClosed
	}
	boosters = dedupe(boosters)
	for _, b := range boosters {
		if b != engine.BoosterExtraMoves && b != engine.BoosterShield {
			return nil, fmt.Errorf("%w: %s", ErrUnknownBooster, b)
		}
	}

	p, err := s.players.Mutate(ctx, playerID, func(p *domain.Player) error {
		if p.Lives < cfg.LivesCost {
			return ErrInsufficientLives
		}
		for _, b := range boosters {
			if p.Boosters[b] <= 0 {
				return fmt.Errorf("%w: %s", ErrInsufficientBoosters, b)
			}
		}
		if p.Lives == p.MaxLives && cfg.LivesCost > 0 {
			p.LivesUpdatedAt = s.now() // regeneration clock starts when leaving full
		}
		p.Lives -= cfg.LivesCost
		for _, b := range boosters {
			p.Boosters[b]--
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	run := &domain.Run{
		ID: ids.New("run"), PlayerID: playerID, EventID: meta.ID, Seed: cfg.Seed, ConfigVersion: cfg.Version,
		Boosters: boosters, Status: domain.RunActive, StartedAt: now, ExpiresAt: minTime(now.Add(s.runTTL), meta.EndsAt.Add(15*time.Minute)),
	}
	if run.Boosters == nil {
		run.Boosters = []string{}
	}
	if err := s.store.Runs().Put(ctx, run); err != nil {
		return nil, err
	}
	if s.bus != nil {
		s.bus.Publish(telemetry.Event{ID: ids.New("evt"), Type: telemetry.RunStarted, PlayerID: playerID, Group: p.ExperimentGroup, EventID: meta.ID, RunID: run.ID, Name: p.DisplayName})
		for _, b := range boosters {
			s.bus.Publish(telemetry.Event{ID: ids.New("evt"), Type: telemetry.BoosterUsed, PlayerID: playerID, Group: p.ExperimentGroup, EventID: meta.ID, RunID: run.ID, Booster: b})
		}
	}
	return &StartResult{Run: run, Config: cfg}, nil
}

// FinishResult is the settled outcome.
type FinishResult struct {
	Run    *domain.Run
	Result engine.Result
	Reward *domain.Reward
	Player *domain.Player
}

// Finish validates and settles a run. See docs/api.md for the ordered
// validation chain; every step maps to a distinct error code.
func (s *Service) Finish(ctx context.Context, playerID, runID string, rep engine.Replay) (*FinishResult, error) {
	run, err := s.store.Runs().Get(ctx, playerID, runID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			// Either the run does not exist or it belongs to someone else; the
			// key includes the player so both look identical to the store. We
			// deliberately do not distinguish them to avoid leaking run ids.
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	if run.PlayerID != playerID {
		return nil, ErrForbidden
	}
	if run.Status != domain.RunActive {
		return nil, ErrRunFinished
	}
	now := s.now()
	if now.After(run.ExpiresAt) {
		return nil, ErrRunExpired
	}
	cfg, err := s.live.GetConfig(ctx, run.EventID, run.ConfigVersion)
	if err != nil {
		return nil, fmt.Errorf("load pinned config v%d: %w", run.ConfigVersion, err)
	}

	result, err := engine.Run(cfg, run.Seed, run.Boosters, rep)
	if err != nil {
		return nil, err // wraps engine.ErrInvalidReplay
	}
	if result.Score != rep.ClientScore {
		return nil, fmt.Errorf("%w: client %d, server %d", ErrScoreMismatch, rep.ClientScore, result.Score)
	}
	if err := engine.Plausible(cfg, rep); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrImplausible, err)
	}

	// 1. Settle the run — the conditional write is the source of truth and
	//    the guard against double scoring.
	finished := now
	run.FinishedAt = &finished
	run.Result = &result
	run.DurationMs = rep.DurationMs
	if err := s.store.Runs().Finish(ctx, run); err != nil {
		if errors.Is(err, domain.ErrConflict) {
			return nil, ErrRunFinished
		}
		return nil, err
	}

	// 2. Grant the reward (idempotent id) and update progression.
	rw, err := s.rewards.GrantRunLoot(ctx, run, result.Score)
	if err != nil {
		s.log.Error("run settled but reward grant failed", "run", run.ID, "err", err)
		return nil, err
	}
	p, err := s.players.Mutate(ctx, playerID, func(p *domain.Player) error {
		p.Stats.Runs++
		p.Stats.TotalLoot += result.Loot
		p.Stats.VaultsCracked += int64(result.VaultsCracked)
		if result.Score > p.Stats.BestScore {
			p.Stats.BestScore = result.Score
		}
		return nil
	})
	if err != nil {
		s.log.Error("run settled but stats update failed", "run", run.ID, "err", err)
		return nil, err
	}

	// 3. Everything else is asynchronous.
	if s.bus != nil {
		s.bus.Publish(telemetry.Event{
			ID: ids.New("evt"), Type: telemetry.RunFinished, PlayerID: playerID, Group: p.ExperimentGroup, EventID: run.EventID, RunID: run.ID,
			Vault: result.VaultReached, Score: result.Score, Loot: result.Loot, Outcome: string(result.Outcome), Name: p.DisplayName,
		})
		for v := 2; v <= result.VaultReached; v++ {
			s.bus.Publish(telemetry.Event{ID: ids.New("evt"), Type: telemetry.VaultReached, PlayerID: playerID, Group: p.ExperimentGroup, EventID: run.EventID, RunID: run.ID, Vault: v})
		}
	}
	return &FinishResult{Run: run, Result: result, Reward: rw, Player: p}, nil
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
