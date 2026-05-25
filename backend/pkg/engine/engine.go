package engine

import (
	"errors"
	"fmt"
)

// VaultState is the lifecycle state of a vault in play.
type VaultState int

const (
	Playing VaultState = iota
	Cracked
	Busted
)

func (s VaultState) String() string {
	switch s {
	case Playing:
		return "PLAYING"
	case Cracked:
		return "CRACKED"
	case Busted:
		return "BUSTED"
	}
	return "UNKNOWN"
}

// ErrInvalidMove is returned (wrapped) for every illegal chain.
var ErrInvalidMove = errors.New("invalid move")

// Sim is a single vault simulation. It owns the board but borrows the RNG so
// that a run can keep one stream across vaults.
type Sim struct {
	W, H       int
	Grid       []int
	Vault      Vault
	Objectives Objectives
	MovesLeft  int
	Loot       int64 // loot earned in this vault only
	State      VaultState
	rng        *RNG
	weights    Weights
	reshuffles int
}

// MoveResult summarises what a move produced; the client uses it to drive
// animation, the server ignores everything but the state transition.
type MoveResult struct {
	Tile       int
	Length     int
	Pct        int
	Loot       int64
	BonusMove  bool
	Unlocked   []int
	Objectives Objectives
	State      VaultState
}

// NewSim sets up a vault board deterministically from the shared RNG.
func NewSim(rng *RNG, cfg *Config, vaultIndex int, boosters []string) *Sim {
	v := cfg.Vaults[vaultIndex]
	s := &Sim{
		W:          cfg.Grid.W,
		H:          cfg.Grid.H,
		Vault:      v,
		Objectives: ScaledObjectives(v.Objectives, cfg.DifficultyPct()),
		MovesLeft:  v.Moves,
		State:      Playing,
		rng:        rng,
		weights:    v.Weights,
	}
	if hasBooster(boosters, BoosterExtraMoves) {
		s.MovesLeft += ExtraMovesBonus
	}
	s.Grid = make([]int, s.W*s.H)
	s.generate()
	return s
}

func hasBooster(boosters []string, id string) bool {
	for _, b := range boosters {
		if b == id {
			return true
		}
	}
	return false
}

func (s *Sim) randomTile() int {
	ordered := s.weights.ordered()
	r := s.rng.NextInt(s.weights.total())
	for t, w := range ordered {
		if r < w {
			return t
		}
		r -= w
	}
	return Money // unreachable when weights are valid
}

func (s *Sim) generate() {
	for i := range s.Grid {
		s.Grid[i] = s.randomTile()
	}
	placed := 0
	cells := s.W * s.H
	for placed < s.Vault.Locks {
		idx := s.rng.NextInt(cells)
		if s.Grid[idx] != Lock {
			s.Grid[idx] = Lock
			placed++
		}
	}
	if !s.HasAnyMove() {
		s.reshuffle()
	}
}

// reshuffle redraws every non-lock cell until at least one chain exists.
func (s *Sim) reshuffle() {
	for attempt := 0; attempt < 100; attempt++ {
		for i := range s.Grid {
			if s.Grid[i] != Lock {
				s.Grid[i] = s.randomTile()
			}
		}
		s.reshuffles++
		if s.HasAnyMove() {
			return
		}
	}
}

// HasAnyMove reports whether a 3-chain exists: some non-lock cell must have at
// least two same-typed 8-neighbours.
func (s *Sim) HasAnyMove() bool {
	for r := 0; r < s.H; r++ {
		for c := 0; c < s.W; c++ {
			t := s.Grid[r*s.W+c]
			if t == Lock || t == Empty {
				continue
			}
			n := 0
			for dr := -1; dr <= 1; dr++ {
				for dc := -1; dc <= 1; dc++ {
					if dr == 0 && dc == 0 {
						continue
					}
					rr, cc := r+dr, c+dc
					if rr < 0 || rr >= s.H || cc < 0 || cc >= s.W {
						continue
					}
					if s.Grid[rr*s.W+cc] == t {
						n++
					}
				}
			}
			if n >= 2 {
				return true
			}
		}
	}
	return false
}

// ValidatePath checks a chain without mutating state.
func (s *Sim) ValidatePath(path []int) error {
	if len(path) < 3 {
		return fmt.Errorf("%w: chain length %d < 3", ErrInvalidMove, len(path))
	}
	cells := s.W * s.H
	seen := make(map[int]struct{}, len(path))
	first := -1
	for i, idx := range path {
		if idx < 0 || idx >= cells {
			return fmt.Errorf("%w: index %d out of range", ErrInvalidMove, idx)
		}
		if _, dup := seen[idx]; dup {
			return fmt.Errorf("%w: index %d repeated", ErrInvalidMove, idx)
		}
		seen[idx] = struct{}{}
		t := s.Grid[idx]
		if t == Lock || t == Empty {
			return fmt.Errorf("%w: cell %d is not chainable", ErrInvalidMove, idx)
		}
		if i == 0 {
			first = t
		} else {
			if t != first {
				return fmt.Errorf("%w: mixed tile types", ErrInvalidMove)
			}
			pr, pc := path[i-1]/s.W, path[i-1]%s.W
			r, c := idx/s.W, idx%s.W
			if abs(pr-r) > 1 || abs(pc-c) > 1 {
				return fmt.Errorf("%w: cells %d and %d are not adjacent", ErrInvalidMove, path[i-1], idx)
			}
		}
	}
	return nil
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// Apply performs a move. It returns an error (and leaves the board untouched)
// when the chain is illegal or the vault is no longer in play.
func (s *Sim) Apply(path []int) (MoveResult, error) {
	if s.State != Playing {
		return MoveResult{}, fmt.Errorf("%w: vault is %s", ErrInvalidMove, s.State)
	}
	if err := s.ValidatePath(path); err != nil {
		return MoveResult{}, err
	}
	t := s.Grid[path[0]]
	n := len(path)
	pct := ChainPct(n)
	loot := int64(n*BaseLoot[t]*pct) / 100
	s.Loot += loot

	switch t {
	case Key:
		s.Objectives.Key = max(0, s.Objectives.Key-n)
	case Laser:
		s.Objectives.Laser = max(0, s.Objectives.Laser-n)
	case Camera:
		s.Objectives.Camera = max(0, s.Objectives.Camera-n)
	}
	s.MovesLeft--
	bonus := false
	if t == Guard {
		s.MovesLeft++
		bonus = true
	}

	// Unlock locks orthogonally adjacent to the removed chain, in index order.
	inPath := make(map[int]bool, n)
	for _, idx := range path {
		inPath[idx] = true
	}
	var unlocked []int
	for idx := 0; idx < s.W*s.H; idx++ {
		if s.Grid[idx] != Lock {
			continue
		}
		r, c := idx/s.W, idx%s.W
		if (r > 0 && inPath[idx-s.W]) || (r < s.H-1 && inPath[idx+s.W]) || (c > 0 && inPath[idx-1]) || (c < s.W-1 && inPath[idx+1]) {
			s.Grid[idx] = s.randomTile()
			unlocked = append(unlocked, idx)
		}
	}

	for _, idx := range path {
		s.Grid[idx] = Empty
	}
	s.collapseAndRefill()

	if s.Objectives.Key == 0 && s.Objectives.Laser == 0 && s.Objectives.Camera == 0 {
		s.State = Cracked
	} else if s.MovesLeft <= 0 {
		s.State = Busted
	} else if !s.HasAnyMove() {
		s.reshuffle()
	}

	return MoveResult{
		Tile:       t,
		Length:     n,
		Pct:        pct,
		Loot:       loot,
		BonusMove:  bonus,
		Unlocked:   unlocked,
		Objectives: s.Objectives,
		State:      s.State,
	}, nil
}

// Gravity report used by the client for animation: for every column, which
// source row moved to which destination row, and how many new tiles spawned.
func (s *Sim) collapseAndRefill() {
	for c := 0; c < s.W; c++ {
		write := s.H - 1
		for r := s.H - 1; r >= 0; r-- {
			if s.Grid[r*s.W+c] != Empty {
				s.Grid[write*s.W+c] = s.Grid[r*s.W+c]
				write--
			}
		}
		for r := 0; r <= write; r++ {
			s.Grid[r*s.W+c] = s.randomTile()
		}
	}
}

// Reshuffles reports how many times the board had to be redrawn.
func (s *Sim) Reshuffles() int { return s.reshuffles }

// Clone returns a deep copy sharing the same RNG pointer (useful for lookahead
// only when the RNG is also cloned by the caller).
func (s *Sim) Clone(rng *RNG) *Sim {
	c := *s
	c.Grid = append([]int(nil), s.Grid...)
	c.rng = rng
	return &c
}
