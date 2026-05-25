package engine

import (
	"errors"
	"fmt"
)

// Outcome of a finished run.
type Outcome string

const (
	OutcomeEscaped Outcome = "ESCAPED"
	OutcomeBusted  Outcome = "BUSTED"
)

// VaultReplay is the list of chains played in one vault.
type VaultReplay struct {
	Moves [][]int `json:"moves"`
}

// Replay is the complete client submission for a run.
type Replay struct {
	Vaults      []VaultReplay `json:"vaults"`
	Escaped     bool          `json:"escaped"`
	ClientScore int64         `json:"clientScore"`
	DurationMs  int64         `json:"durationMs"`
}

// Result is the authoritative outcome computed by the server.
type Result struct {
	Outcome       Outcome `json:"outcome"`
	Score         int64   `json:"score"`
	Loot          int64   `json:"loot"`
	VaultReached  int     `json:"vaultReached"`
	VaultsCracked int     `json:"vaultsCracked"`
	Multiplier    float64 `json:"multiplier"`
	TotalMoves    int     `json:"totalMoves"`
}

// ErrInvalidReplay wraps every structural replay problem.
var ErrInvalidReplay = errors.New("invalid replay")

// TotalMoves counts chains across all vaults.
func (r Replay) TotalMoves() int {
	n := 0
	for _, v := range r.Vaults {
		n += len(v.Moves)
	}
	return n
}

// Run replays a full heist and scores it. The RNG stream is seeded once and
// shared by every vault, exactly like the client does while playing.
func Run(cfg *Config, seed uint32, boosters []string, rep Replay) (Result, error) {
	if len(rep.Vaults) == 0 {
		return Result{}, fmt.Errorf("%w: no vaults", ErrInvalidReplay)
	}
	if len(rep.Vaults) > len(cfg.Vaults) {
		return Result{}, fmt.Errorf("%w: %d vaults submitted, event has %d", ErrInvalidReplay, len(rep.Vaults), len(cfg.Vaults))
	}

	rng := NewRNG(seed)
	var totalLoot int64
	var last *Sim
	cracked := 0
	totalMoves := 0

	for vi, vr := range rep.Vaults {
		sim := NewSim(rng, cfg, vi, boosters)
		for mi, mv := range vr.Moves {
			if sim.State != Playing {
				return Result{}, fmt.Errorf("%w: vault %d has moves after it was %s", ErrInvalidReplay, vi+1, sim.State)
			}
			if _, err := sim.Apply(mv); err != nil {
				return Result{}, fmt.Errorf("%w: vault %d move %d: %v", ErrInvalidReplay, vi+1, mi+1, err)
			}
			totalMoves++
		}
		if sim.State == Playing {
			return Result{}, fmt.Errorf("%w: vault %d left unfinished", ErrInvalidReplay, vi+1)
		}
		if sim.State == Busted && vi != len(rep.Vaults)-1 {
			return Result{}, fmt.Errorf("%w: busted in vault %d but more vaults follow", ErrInvalidReplay, vi+1)
		}
		if sim.State == Cracked {
			cracked++
		}
		totalLoot += sim.Loot
		last = sim
	}

	reached := len(rep.Vaults)
	res := Result{Loot: totalLoot, VaultReached: reached, VaultsCracked: cracked, TotalMoves: totalMoves}

	if last.State == Cracked {
		if !rep.Escaped && reached < len(cfg.Vaults) {
			return Result{}, fmt.Errorf("%w: vault %d cracked but neither escaped nor continued", ErrInvalidReplay, reached)
		}
		mult := cfg.VaultMultipliers[reached-1]
		res.Outcome = OutcomeEscaped
		res.Multiplier = mult
		res.Score = RoundHalfUp(float64(totalLoot) * mult * cfg.LootMultiplier)
		return res, nil
	}

	if rep.Escaped {
		return Result{}, fmt.Errorf("%w: escaped flag set on a busted run", ErrInvalidReplay)
	}
	mult := 1.0
	if reached >= 2 {
		mult = cfg.VaultMultipliers[reached-2]
	}
	penalty := cfg.BustPenalty
	if hasBooster(boosters, BoosterShield) {
		penalty = penalty * 0.5
	}
	res.Outcome = OutcomeBusted
	res.Multiplier = mult
	res.Score = RoundHalfUp(float64(totalLoot) * mult * (1 - penalty) * cfg.LootMultiplier)
	return res, nil
}

// Plausible applies coarse sanity bounds that do not depend on the simulation.
func Plausible(cfg *Config, rep Replay) error {
	moves := rep.TotalMoves()
	if rep.DurationMs < int64(moves)*120 {
		return fmt.Errorf("duration %dms too short for %d moves", rep.DurationMs, moves)
	}
	if rep.DurationMs > 6*60*60*1000 {
		return fmt.Errorf("duration %dms exceeds 6h", rep.DurationMs)
	}
	maxMoves := 0
	for _, v := range cfg.Vaults {
		maxMoves += v.Moves + ExtraMovesBonus + GuardBonusCap
	}
	if moves > maxMoves {
		return fmt.Errorf("%d moves exceeds the maximum of %d", moves, maxMoves)
	}
	return nil
}
