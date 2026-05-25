package engine

import (
	"errors"
	"fmt"
	"math"
	"time"
)

// Tile identifiers. The numeric values are part of the wire/replay contract.
const (
	Key     = 0
	Laser   = 1
	Camera  = 2
	Money   = 3
	Diamond = 4
	Guard   = 5
	Lock    = 6
	Empty   = -1
)

// TileCount is the number of chainable + lock tile kinds.
const TileCount = 7

// TileNames maps tile ids to their canonical lowercase names.
var TileNames = [TileCount]string{"key", "laser", "camera", "money", "diamond", "guard", "lock"}

// BaseLoot is the loot value of a single tile of each kind.
var BaseLoot = [TileCount]int{40, 40, 40, 100, 250, 30, 0}

// Booster identifiers.
const (
	BoosterExtraMoves = "extra_moves"
	BoosterShield     = "shield"
)

// ExtraMovesBonus is how many extra moves BoosterExtraMoves grants per vault.
const ExtraMovesBonus = 3

// GuardBonusCap bounds how many bonus moves a single vault may yield (used only
// for plausibility checks, never by the simulation itself).
const GuardBonusCap = 20

// Grid dimensions.
type Grid struct {
	W int `json:"w"`
	H int `json:"h"`
}

// Objectives are the security systems that must be disabled to crack a vault.
type Objectives struct {
	Key    int `json:"key"`
	Laser  int `json:"laser"`
	Camera int `json:"camera"`
}

// Weights control the tile distribution of a vault. Zero disables a kind.
type Weights struct {
	Key     int `json:"key"`
	Laser   int `json:"laser"`
	Camera  int `json:"camera"`
	Money   int `json:"money"`
	Diamond int `json:"diamond"`
	Guard   int `json:"guard"`
}

func (w Weights) total() int {
	return w.Key + w.Laser + w.Camera + w.Money + w.Diamond + w.Guard
}

func (w Weights) ordered() [6]int {
	return [6]int{w.Key, w.Laser, w.Camera, w.Money, w.Diamond, w.Guard}
}

// Vault describes a single stage of a heist.
type Vault struct {
	Name       string     `json:"name"`
	Moves      int        `json:"moves"`
	Objectives Objectives `json:"objectives"`
	Locks      int        `json:"locks"`
	Weights    Weights    `json:"weights"`
}

// Config is a versioned event configuration. It is what LiveOps edits and what
// every run pins by version.
type Config struct {
	EventID          string    `json:"eventId"`
	Version          int       `json:"version"`
	Seed             uint32    `json:"seed"`
	Difficulty       float64   `json:"difficulty"`
	LootMultiplier   float64   `json:"lootMultiplier"`
	LivesCost        int       `json:"livesCost"`
	Grid             Grid      `json:"grid"`
	VaultMultipliers []float64 `json:"vaultMultipliers"`
	BustPenalty      float64   `json:"bustPenalty"`
	Vaults           []Vault   `json:"vaults"`
	CreatedAt        time.Time `json:"createdAt"`
	CreatedBy        string    `json:"createdBy,omitempty"`
	Note             string    `json:"note,omitempty"`
}

// Validate checks structural sanity of a config. It is used by the LiveOps API
// before a new version is persisted so a typo can never brick the live event.
func (c *Config) Validate() error {
	var errs []error
	if c.Grid.W < 4 || c.Grid.W > 12 || c.Grid.H < 4 || c.Grid.H > 12 {
		errs = append(errs, fmt.Errorf("grid must be between 4x4 and 12x12, got %dx%d", c.Grid.W, c.Grid.H))
	}
	if c.Difficulty < 0.25 || c.Difficulty > 4 {
		errs = append(errs, fmt.Errorf("difficulty %.2f out of range [0.25, 4]", c.Difficulty))
	}
	if c.LootMultiplier < 0.1 || c.LootMultiplier > 10 {
		errs = append(errs, fmt.Errorf("lootMultiplier %.2f out of range [0.1, 10]", c.LootMultiplier))
	}
	if c.LivesCost < 0 || c.LivesCost > 5 {
		errs = append(errs, fmt.Errorf("livesCost %d out of range [0, 5]", c.LivesCost))
	}
	if c.BustPenalty < 0 || c.BustPenalty > 1 {
		errs = append(errs, fmt.Errorf("bustPenalty %.2f out of range [0, 1]", c.BustPenalty))
	}
	if len(c.Vaults) == 0 || len(c.Vaults) > 10 {
		errs = append(errs, fmt.Errorf("vaults must contain 1..10 entries, got %d", len(c.Vaults)))
	}
	if len(c.VaultMultipliers) != len(c.Vaults) {
		errs = append(errs, fmt.Errorf("vaultMultipliers has %d entries, vaults has %d", len(c.VaultMultipliers), len(c.Vaults)))
	}
	for i, m := range c.VaultMultipliers {
		if m <= 0 || m > 50 {
			errs = append(errs, fmt.Errorf("vaultMultipliers[%d]=%.2f out of range", i, m))
		}
	}
	cells := c.Grid.W * c.Grid.H
	for i, v := range c.Vaults {
		if v.Moves < 1 || v.Moves > 200 {
			errs = append(errs, fmt.Errorf("vaults[%d].moves %d out of range [1, 200]", i, v.Moves))
		}
		if v.Locks < 0 || v.Locks >= cells/2 {
			errs = append(errs, fmt.Errorf("vaults[%d].locks %d out of range [0, %d)", i, v.Locks, cells/2))
		}
		if v.Weights.total() <= 0 {
			errs = append(errs, fmt.Errorf("vaults[%d].weights must sum to > 0", i))
		}
		for _, w := range v.Weights.ordered() {
			if w < 0 {
				errs = append(errs, fmt.Errorf("vaults[%d].weights contain a negative value", i))
				break
			}
		}
		if v.Objectives.Key < 0 || v.Objectives.Laser < 0 || v.Objectives.Camera < 0 {
			errs = append(errs, fmt.Errorf("vaults[%d].objectives contain a negative value", i))
		}
		if v.Objectives.Key == 0 && v.Objectives.Laser == 0 && v.Objectives.Camera == 0 {
			errs = append(errs, fmt.Errorf("vaults[%d] has no objectives", i))
		}
		if (v.Objectives.Key > 0 && v.Weights.Key == 0) || (v.Objectives.Laser > 0 && v.Weights.Laser == 0) || (v.Objectives.Camera > 0 && v.Weights.Camera == 0) {
			errs = append(errs, fmt.Errorf("vaults[%d] requires a tile kind whose weight is 0 (unwinnable)", i))
		}
	}
	return errors.Join(errs...)
}

// DifficultyPct converts the float difficulty into the integer percentage used
// by the simulation (1.25 → 125). Both ports do exactly this conversion.
func (c *Config) DifficultyPct() int {
	return int(math.Floor(c.Difficulty*100 + 0.5))
}

// ScaledObjectives applies difficulty with round-half-up integer math.
func ScaledObjectives(base Objectives, difficultyPct int) Objectives {
	scale := func(v int) int {
		if v == 0 {
			return 0
		}
		return (v*difficultyPct + 50) / 100
	}
	return Objectives{Key: scale(base.Key), Laser: scale(base.Laser), Camera: scale(base.Camera)}
}

// ChainPct returns the loot multiplier (in percent) for a chain length.
func ChainPct(n int) int {
	switch {
	case n >= 6:
		return 300
	case n == 5:
		return 200
	case n == 4:
		return 150
	default:
		return 100
	}
}

// RoundHalfUp mirrors JavaScript's Math.round for non-negative values.
func RoundHalfUp(x float64) int64 {
	return int64(math.Floor(x + 0.5))
}

// DefaultVaults is the tuned five-vault progression used when a new daily
// event is auto-provisioned.
func DefaultVaults() []Vault {
	w := func(k, l, c, m, d, g int) Weights { return Weights{k, l, c, m, d, g} }
	return []Vault{
		{Name: "Lobby Safe", Moves: 12, Objectives: Objectives{Key: 9}, Locks: 0, Weights: w(26, 12, 12, 22, 10, 12)},
		{Name: "Archive Vault", Moves: 16, Objectives: Objectives{Key: 11, Laser: 9}, Locks: 2, Weights: w(21, 19, 12, 20, 10, 12)},
		{Name: "Gallery Vault", Moves: 18, Objectives: Objectives{Key: 13, Laser: 11, Camera: 9}, Locks: 3, Weights: w(20, 18, 16, 18, 10, 12)},
		{Name: "Director's Vault", Moves: 18, Objectives: Objectives{Key: 15, Laser: 13, Camera: 13}, Locks: 4, Weights: w(20, 18, 18, 16, 10, 12)},
		{Name: "The Crown Vault", Moves: 20, Objectives: Objectives{Key: 17, Laser: 15, Camera: 15}, Locks: 6, Weights: w(20, 18, 18, 14, 12, 12)},
	}
}

// DefaultConfig builds the baseline configuration for an event.
func DefaultConfig(eventID string, seed uint32, now time.Time) Config {
	return Config{
		EventID:          eventID,
		Version:          1,
		Seed:             seed,
		Difficulty:       1.0,
		LootMultiplier:   1.0,
		LivesCost:        1,
		Grid:             Grid{W: 7, H: 7},
		VaultMultipliers: []float64{1, 1.5, 2, 3, 5},
		BustPenalty:      0.5,
		Vaults:           DefaultVaults(),
		CreatedAt:        now,
		CreatedBy:        "system",
		Note:             "auto-provisioned baseline",
	}
}
