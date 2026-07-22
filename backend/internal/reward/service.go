// Package reward grants and claims rewards exactly once.
//
// The claim is a conditional state flip (PENDING → CLAIMED) in the store;
// only the request that wins the flip credits the profile. A retry after a
// lost response therefore sees CLAIMED and gets a conflict, never a second
// payout.
package reward

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/ids"
	"github.com/atakank/vault-rush/backend/internal/player"
	"github.com/atakank/vault-rush/backend/internal/store"
	"github.com/atakank/vault-rush/backend/internal/telemetry"
)

// ErrAlreadyClaimed is returned when the reward was claimed before.
var ErrAlreadyClaimed = errors.New("reward already claimed")

// Service is the reward service.
type Service struct {
	store   store.Store
	players *player.Service
	bus     *telemetry.Bus
	log     *slog.Logger
	now     func() time.Time
}

// New wires the service.
func New(st store.Store, players *player.Service, bus *telemetry.Bus, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{store: st, players: players, bus: bus, log: log, now: func() time.Time { return time.Now().UTC() }}
}

// RunLootCoins converts a run score into a coin grant.
func RunLootCoins(score int64) int64 {
	c := score / 100
	if c < 10 {
		c = 10
	}
	return c
}

// LeaderboardCoins is the payout table for the daily heist podium.
func LeaderboardCoins(rank int64) int64 {
	switch {
	case rank == 1:
		return 5000
	case rank <= 3:
		return 3000
	case rank <= 10:
		return 1500
	case rank <= 100:
		return 500
	default:
		return 0
	}
}

// GrantRunLoot creates the pending reward for a finished run. The reward id
// is derived from the run id so re-granting is idempotent.
func (s *Service) GrantRunLoot(ctx context.Context, run *domain.Run, score int64) (*domain.Reward, error) {
	r := &domain.Reward{
		ID: "rwd_" + run.ID, PlayerID: run.PlayerID, Type: domain.RewardTypeRunLoot,
		Title: "Heist loot", Coins: RunLootCoins(score), Status: domain.RewardPending,
		EventID: run.EventID, RunID: run.ID, CreatedAt: s.now(),
	}
	if err := s.store.Rewards().Create(ctx, r); err != nil {
		if errors.Is(err, domain.ErrAlreadyExists) {
			return s.store.Rewards().Get(ctx, run.PlayerID, r.ID)
		}
		return nil, err
	}
	return r, nil
}

// GrantLeaderboard creates the podium reward for an event.
func (s *Service) GrantLeaderboard(ctx context.Context, eventID, playerID string, rank int64) (*domain.Reward, error) {
	coins := LeaderboardCoins(rank)
	if coins == 0 {
		return nil, nil
	}
	r := &domain.Reward{
		ID: fmt.Sprintf("rwd_lb_%s", eventID), PlayerID: playerID, Type: domain.RewardTypeLeaderboard,
		Title: fmt.Sprintf("Global Heist rank #%d", rank), Coins: coins, Status: domain.RewardPending,
		EventID: eventID, Rank: rank, CreatedAt: s.now(),
	}
	if rank <= 3 {
		r.Boosters = map[string]int{"shield": 1}
	}
	if err := s.store.Rewards().Create(ctx, r); err != nil {
		if errors.Is(err, domain.ErrAlreadyExists) {
			return s.store.Rewards().Get(ctx, playerID, r.ID)
		}
		return nil, err
	}
	return r, nil
}

// ListPending returns unclaimed rewards.
func (s *Service) ListPending(ctx context.Context, playerID string) ([]*domain.Reward, error) {
	out, err := s.store.Rewards().ListPending(ctx, playerID)
	if err != nil {
		return nil, err
	}
	if out == nil {
		out = []*domain.Reward{}
	}
	return out, nil
}

// Claim flips the reward and credits the profile.
func (s *Service) Claim(ctx context.Context, playerID, rewardID string) (*domain.Reward, *domain.Player, error) {
	r, err := s.store.Rewards().Claim(ctx, playerID, rewardID, s.now())
	if err != nil {
		if errors.Is(err, domain.ErrConflict) {
			return nil, nil, ErrAlreadyClaimed
		}
		return nil, nil, err
	}
	p, err := s.players.Mutate(ctx, playerID, func(p *domain.Player) error {
		p.Coins += r.Coins
		for k, v := range r.Boosters {
			if p.Boosters == nil {
				p.Boosters = map[string]int{}
			}
			p.Boosters[k] += v
		}
		return nil
	})
	if err != nil {
		// The flip already happened; this must not be silent. In production a
		// reconciliation job re-credits CLAIMED rewards whose payout failed.
		s.log.Error("reward claimed but profile credit failed", "player", playerID, "reward", rewardID, "err", err)
		return nil, nil, err
	}
	if s.bus != nil {
		s.bus.Publish(telemetry.Event{ID: ids.New("evt"), Type: telemetry.RewardClaimed, PlayerID: playerID, Group: p.ExperimentGroup, EventID: r.EventID, Coins: r.Coins})
	}
	return r, p, nil
}
