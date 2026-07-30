package reward

import (
	"context"
	"log/slog"
	"time"

	"github.com/atakank/vault-rush/backend/internal/leaderboard"
	"github.com/atakank/vault-rush/backend/internal/liveops"
)

// Distributor is the scheduled job that pays out leaderboard rewards once an
// event has ended. It is idempotent: reward ids are derived from the event,
// and the event is flagged after a successful pass.
type Distributor struct {
	rewards  *Service
	live     *liveops.Service
	lb       *leaderboard.Service
	log      *slog.Logger
	lookback time.Duration
}

// NewDistributor wires the job.
func NewDistributor(rewards *Service, live *liveops.Service, lb *leaderboard.Service, log *slog.Logger) *Distributor {
	if log == nil {
		log = slog.Default()
	}
	return &Distributor{rewards: rewards, live: live, lb: lb, log: log, lookback: 72 * time.Hour}
}

// RunOnce distributes rewards for every ended, undistributed event.
func (d *Distributor) RunOnce(ctx context.Context) (int, error) {
	events, err := d.live.EndedUndistributed(ctx, d.lookback)
	if err != nil {
		return 0, err
	}
	granted := 0
	for _, ev := range events {
		top, err := d.lb.Top(ctx, ev.ID, 100)
		if err != nil {
			d.log.Warn("distributor: leaderboard unavailable, will retry", "event", ev.ID, "err", err)
			continue
		}
		failed := false
		for _, e := range top {
			if _, err := d.rewards.GrantLeaderboard(ctx, ev.ID, e.PlayerID, e.Rank); err != nil {
				d.log.Error("distributor: grant failed", "event", ev.ID, "player", e.PlayerID, "err", err)
				failed = true
				break
			}
			granted++
		}
		if failed {
			continue // leave the flag unset so the next tick retries idempotently
		}
		ev.RewardsDistributed = true
		if err := d.live.UpdateMeta(ctx, ev); err != nil {
			d.log.Error("distributor: could not flag event", "event", ev.ID, "err", err)
			continue
		}
		d.log.Info("distributor: rewards distributed", "event", ev.ID, "winners", len(top))
	}
	return granted, nil
}

// Loop runs RunOnce on an interval until ctx is cancelled.
func (d *Distributor) Loop(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if _, err := d.RunOnce(ctx); err != nil {
			d.log.Error("distributor tick failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
