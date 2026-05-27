package engine

// Bot is a deterministic heuristic player. It exists for tests, golden fixture
// generation, load testing and the demo seeder — never for production scoring.
type Bot struct {
	// MaxChain bounds the DFS so worst-case boards stay cheap.
	MaxChain int
	// Greedy prefers loot over objectives when true (used to produce busted runs).
	Greedy bool
}

// LongestChain finds the longest legal chain starting anywhere, restricted to
// the given tile kinds (empty = all chainable). Ties resolve to the lowest
// starting index, then lexicographically smallest path, so the output is stable.
func (b Bot) LongestChain(s *Sim, kinds map[int]bool) []int {
	maxLen := b.MaxChain
	if maxLen <= 0 {
		maxLen = 7
	}
	var best []int
	cells := s.W * s.H
	visited := make([]bool, cells)
	path := make([]int, 0, maxLen)

	var dfs func(idx, t int)
	dfs = func(idx, t int) {
		path = append(path, idx)
		visited[idx] = true
		if len(path) >= 3 && len(path) > len(best) {
			best = append(best[:0], path...)
		}
		if len(path) < maxLen {
			r, c := idx/s.W, idx%s.W
			for dr := -1; dr <= 1; dr++ {
				for dc := -1; dc <= 1; dc++ {
					if dr == 0 && dc == 0 {
						continue
					}
					rr, cc := r+dr, c+dc
					if rr < 0 || rr >= s.H || cc < 0 || cc >= s.W {
						continue
					}
					ni := rr*s.W + cc
					if !visited[ni] && s.Grid[ni] == t {
						dfs(ni, t)
					}
				}
			}
		}
		visited[idx] = false
		path = path[:len(path)-1]
	}

	for i := 0; i < cells; i++ {
		t := s.Grid[i]
		if t == Lock || t == Empty {
			continue
		}
		if kinds != nil && !kinds[t] {
			continue
		}
		dfs(i, t)
		if len(best) >= maxLen {
			break
		}
	}
	return best
}

// Choose picks the next move for the sim, or nil when none exists.
func (b Bot) Choose(s *Sim) []int {
	if b.Greedy && s.MovesLeft > 6 {
		// A reckless player: chases loot until the clock is nearly out.
		if mv := b.LongestChain(s, map[int]bool{Diamond: true, Money: true}); mv != nil {
			return mv
		}
	}
	needed := map[int]bool{}
	if s.Objectives.Key > 0 {
		needed[Key] = true
	}
	if s.Objectives.Laser > 0 {
		needed[Laser] = true
	}
	if s.Objectives.Camera > 0 {
		needed[Camera] = true
	}
	if mv := b.LongestChain(s, needed); mv != nil {
		return mv
	}
	if s.MovesLeft <= 3 {
		if mv := b.LongestChain(s, map[int]bool{Guard: true}); mv != nil {
			return mv
		}
	}
	return b.LongestChain(s, nil)
}

// PlayRun plays a full heist with the bot, going deeper up to maxVault, and
// returns the replay plus the client-side score the engine computed.
func (b Bot) PlayRun(cfg *Config, seed uint32, boosters []string, maxVault int) (Replay, Result) {
	rng := NewRNG(seed)
	rep := Replay{}
	var totalLoot int64
	cracked := 0
	moves := 0
	var lastState VaultState

	if maxVault <= 0 || maxVault > len(cfg.Vaults) {
		maxVault = len(cfg.Vaults)
	}

	for vi := 0; vi < maxVault; vi++ {
		sim := NewSim(rng, cfg, vi, boosters)
		vr := VaultReplay{}
		for sim.State == Playing {
			mv := b.Choose(sim)
			if mv == nil {
				break // unreachable: reshuffle guarantees a move
			}
			if _, err := sim.Apply(mv); err != nil {
				panic("bot produced an illegal move: " + err.Error())
			}
			vr.Moves = append(vr.Moves, mv)
			moves++
		}
		rep.Vaults = append(rep.Vaults, vr)
		totalLoot += sim.Loot
		lastState = sim.State
		if sim.State == Cracked {
			cracked++
		}
		if sim.State == Busted {
			break
		}
	}
	rep.Escaped = lastState == Cracked
	rep.DurationMs = int64(moves) * 1400

	res, err := Run(cfg, seed, boosters, rep)
	if err != nil {
		panic("bot replay failed to validate: " + err.Error())
	}
	rep.ClientScore = res.Score
	_ = cracked
	_ = totalLoot
	return rep, res
}
