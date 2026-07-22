// Package analytics turns the telemetry stream into cheap per-event counters
// (a Redis hash + sets) and renders them for the LiveOps dashboard.
package analytics

import (
	"context"
	"fmt"
	"sort"

	"github.com/atakank/vault-rush/backend/internal/cache"
	"github.com/atakank/vault-rush/backend/internal/experiment"
	"github.com/atakank/vault-rush/backend/internal/telemetry"
)

// Counter field names (kept short: they are Redis hash keys).
const (
	fPlayers        = "players"
	fRunsStarted    = "runsStarted"
	fRunsCompleted  = "runsCompleted"
	fEscaped        = "escaped"
	fBusted         = "busted"
	fScoreSum       = "scoreSum"
	fVaultSum       = "vaultSum"
	fRewardsClaimed = "rewardsClaimed"
	fVaultPrefix    = "vault:"   // vault:<n> — runs that reached vault n
	fBoosterPrefix  = "booster:" // booster:<id>
	fExpPrefix      = "exp:"     // exp:<experiment>:<group>:<field>
)

// Sink consumes telemetry events and bumps counters.
type Sink struct {
	an cache.Analytics
}

// NewSink creates the sink.
func NewSink(an cache.Analytics) *Sink { return &Sink{an: an} }

func (s *Sink) Name() string { return "analytics" }

func expField(group, field string) string {
	return fmt.Sprintf("%s%s:%s:%s", fExpPrefix, experiment.LivesTest, group, field)
}

// Handle is idempotency-tolerant for the unique-player set but not for pure
// counters; SQS redelivery is rare enough that approximate counts are the
// accepted trade-off (documented in docs/architecture.md).
func (s *Sink) Handle(ctx context.Context, ev telemetry.Event) error {
	inc := map[string]int64{}
	switch ev.Type {
	case telemetry.RunStarted:
		if ev.EventID == "" {
			return nil
		}
		if isNew, err := s.an.AddUnique(ctx, ev.EventID, "players", ev.PlayerID); err != nil {
			return err
		} else if isNew {
			inc[fPlayers] = 1
			if ev.Group != "" {
				inc[expField(ev.Group, "players")] = 1
			}
		}
		inc[fRunsStarted] = 1
		inc[fVaultPrefix+"1"] = 1
		if ev.Group != "" {
			inc[expField(ev.Group, "runsStarted")] = 1
		}
	case telemetry.RunFinished:
		if ev.EventID == "" {
			return nil
		}
		inc[fRunsCompleted] = 1
		inc[fScoreSum] = ev.Score
		inc[fVaultSum] = int64(ev.Vault)
		if ev.Outcome == "ESCAPED" {
			inc[fEscaped] = 1
		} else {
			inc[fBusted] = 1
		}
		if ev.Group != "" {
			inc[expField(ev.Group, "runsCompleted")] = 1
			inc[expField(ev.Group, "scoreSum")] = ev.Score
		}
	case telemetry.VaultReached:
		if ev.EventID == "" || ev.Vault <= 1 {
			return nil // vault 1 is counted at RunStarted
		}
		inc[fmt.Sprintf("%s%d", fVaultPrefix, ev.Vault)] = 1
	case telemetry.BoosterUsed:
		if ev.EventID == "" {
			return nil
		}
		inc[fBoosterPrefix+ev.Booster] = 1
	case telemetry.RewardClaimed:
		if ev.EventID == "" {
			return nil
		}
		inc[fRewardsClaimed] = 1
	default:
		return nil
	}
	return s.an.IncrMany(ctx, ev.EventID, inc)
}

// GroupReport is the per-experiment-group slice of the report.
type GroupReport struct {
	Players        int64   `json:"players"`
	RunsStarted    int64   `json:"runsStarted"`
	RunsCompleted  int64   `json:"runsCompleted"`
	RunsPerUser    float64 `json:"runsPerUser"`
	CompletionRate float64 `json:"completionRate"`
	AvgScore       float64 `json:"avgScore"`
}

// Dropoff is one bar of the funnel chart.
type Dropoff struct {
	Vault   int     `json:"vault"`
	Reached int64   `json:"reached"`
	Pct     float64 `json:"pct"`
}

// Report is the dashboard payload.
type Report struct {
	EventID        string                            `json:"eventId"`
	Players        int64                             `json:"players"`
	RunsStarted    int64                             `json:"runsStarted"`
	RunsCompleted  int64                             `json:"runsCompleted"`
	CompletionRate float64                           `json:"completionRate"`
	Escaped        int64                             `json:"escaped"`
	Busted         int64                             `json:"busted"`
	AvgVault       float64                           `json:"avgVault"`
	AvgScore       float64                           `json:"avgScore"`
	VaultReached   map[string]int64                  `json:"vaultReached"`
	VaultDropoff   []Dropoff                         `json:"vaultDropoff"`
	BoostersUsed   map[string]int64                  `json:"boostersUsed"`
	RewardsClaimed int64                             `json:"rewardsClaimed"`
	Experiments    map[string]map[string]GroupReport `json:"experiments"`
}

// Service renders reports.
type Service struct {
	an cache.Analytics
}

// New creates the service.
func New(an cache.Analytics) *Service { return &Service{an: an} }

// Report builds the dashboard for an event with vaultCount funnel steps.
func (s *Service) Report(ctx context.Context, eventID string, vaultCount int) (*Report, error) {
	snap, err := s.an.Snapshot(ctx, eventID)
	if err != nil {
		return nil, err
	}
	r := &Report{
		EventID: eventID, Players: snap[fPlayers], RunsStarted: snap[fRunsStarted], RunsCompleted: snap[fRunsCompleted],
		Escaped: snap[fEscaped], Busted: snap[fBusted], RewardsClaimed: snap[fRewardsClaimed],
		VaultReached: map[string]int64{}, BoostersUsed: map[string]int64{},
		Experiments: map[string]map[string]GroupReport{},
	}
	if r.RunsStarted > 0 {
		r.CompletionRate = round3(float64(r.RunsCompleted) / float64(r.RunsStarted))
	}
	if r.RunsCompleted > 0 {
		r.AvgVault = round2(float64(snap[fVaultSum]) / float64(r.RunsCompleted))
		r.AvgScore = round2(float64(snap[fScoreSum]) / float64(r.RunsCompleted))
	}
	if vaultCount <= 0 {
		vaultCount = 5
	}
	base := snap[fVaultPrefix+"1"]
	for v := 1; v <= vaultCount; v++ {
		n := snap[fmt.Sprintf("%s%d", fVaultPrefix, v)]
		r.VaultReached[fmt.Sprint(v)] = n
		pct := 0.0
		if base > 0 {
			pct = round3(float64(n) / float64(base))
		}
		r.VaultDropoff = append(r.VaultDropoff, Dropoff{Vault: v, Reached: n, Pct: pct})
	}
	for k, v := range snap {
		if len(k) > len(fBoosterPrefix) && k[:len(fBoosterPrefix)] == fBoosterPrefix {
			r.BoostersUsed[k[len(fBoosterPrefix):]] = v
		}
	}
	groups := map[string]GroupReport{}
	for _, g := range []string{"A", "B"} {
		gr := GroupReport{
			Players:       snap[expField(g, "players")],
			RunsStarted:   snap[expField(g, "runsStarted")],
			RunsCompleted: snap[expField(g, "runsCompleted")],
		}
		if gr.Players > 0 {
			gr.RunsPerUser = round2(float64(gr.RunsStarted) / float64(gr.Players))
		}
		if gr.RunsStarted > 0 {
			gr.CompletionRate = round3(float64(gr.RunsCompleted) / float64(gr.RunsStarted))
		}
		if gr.RunsCompleted > 0 {
			gr.AvgScore = round2(float64(snap[expField(g, "scoreSum")]) / float64(gr.RunsCompleted))
		}
		groups[g] = gr
	}
	r.Experiments[experiment.LivesTest] = groups
	return r, nil
}

func round2(f float64) float64 { return float64(int64(f*100+0.5)) / 100 }
func round3(f float64) float64 { return float64(int64(f*1000+0.5)) / 1000 }

// SortedKeys is a small helper for deterministic debug output.
func SortedKeys(m map[string]int64) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
