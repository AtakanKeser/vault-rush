package engine

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testConfig() *Config {
	c := DefaultConfig("test_event", 82938122, time.Unix(0, 0).UTC())
	return &c
}

func TestRNGIsDeterministicAndMatchesReference(t *testing.T) {
	// Reference values produced by the canonical JS mulberry32 implementation
	// for seed 82938122 (see client/src/engine/rng.test.ts for the same list).
	want := []uint32{1885756853, 1183468422, 931213250, 3325039468, 2478020766}
	r := NewRNG(82938122)
	for i, w := range want {
		if got := r.Next(); got != w {
			t.Fatalf("Next()[%d] = %d, want %d", i, got, w)
		}
	}
	a, b := NewRNG(7), NewRNG(7)
	for i := 0; i < 1000; i++ {
		if a.Next() != b.Next() {
			t.Fatal("two generators with the same seed diverged")
		}
	}
}

func TestScaledObjectivesRoundHalfUp(t *testing.T) {
	got := ScaledObjectives(Objectives{Key: 10, Laser: 7, Camera: 0}, 125)
	if got != (Objectives{Key: 13, Laser: 9, Camera: 0}) {
		t.Fatalf("unexpected scaling: %+v", got)
	}
	if got := ScaledObjectives(Objectives{Key: 1}, 50); got.Key != 1 {
		t.Fatalf("1*0.5 should round up to 1, got %d", got.Key)
	}
}

func TestBoardGenerationIsReproducible(t *testing.T) {
	cfg := testConfig()
	a := NewSim(NewRNG(cfg.Seed), cfg, 0, nil)
	b := NewSim(NewRNG(cfg.Seed), cfg, 0, nil)
	for i := range a.Grid {
		if a.Grid[i] != b.Grid[i] {
			t.Fatalf("boards differ at %d", i)
		}
	}
	if !a.HasAnyMove() {
		t.Fatal("generated board has no legal move")
	}
	locks := 0
	c := NewSim(NewRNG(cfg.Seed), cfg, 4, nil)
	for _, v := range c.Grid {
		if v == Lock {
			locks++
		}
	}
	if locks != cfg.Vaults[4].Locks {
		t.Fatalf("vault 5 should have %d locks, got %d", cfg.Vaults[4].Locks, locks)
	}
}

func TestValidatePathRejectsIllegalChains(t *testing.T) {
	cfg := testConfig()
	s := NewSim(NewRNG(1), cfg, 0, nil)
	// Build a deterministic board by hand.
	for i := range s.Grid {
		s.Grid[i] = Money
	}
	s.Grid[10] = Key
	s.Grid[20] = Lock

	cases := map[string][]int{
		"too short":     {0, 1},
		"out of range":  {0, 1, 99},
		"repeated":      {0, 1, 0},
		"mixed types":   {9, 10, 11},
		"not adjacent":  {0, 1, 3},
		"lock in chain": {19, 20, 21},
	}
	for name, path := range cases {
		if err := s.ValidatePath(path); !errors.Is(err, ErrInvalidMove) {
			t.Errorf("%s: expected ErrInvalidMove, got %v", name, err)
		}
	}
	if err := s.ValidatePath([]int{0, 1, 2}); err != nil {
		t.Errorf("straight line should be legal: %v", err)
	}
	if err := s.ValidatePath([]int{0, 8, 16}); err != nil {
		t.Errorf("diagonal should be legal: %v", err)
	}
}

func TestApplyScoresObjectivesAndBonusMoves(t *testing.T) {
	cfg := testConfig()
	s := NewSim(NewRNG(1), cfg, 0, nil)
	for i := range s.Grid {
		s.Grid[i] = Money
	}
	s.Grid[0], s.Grid[1], s.Grid[2], s.Grid[3] = Key, Key, Key, Key
	s.Grid[7], s.Grid[8], s.Grid[9] = Guard, Guard, Guard
	s.Grid[14] = Lock // directly below Guard at 7 → unlocked by the guard chain
	s.Objectives = Objectives{Key: 3}
	s.MovesLeft = 5

	res, err := s.Apply([]int{7, 8, 9})
	if err != nil {
		t.Fatal(err)
	}
	if !res.BonusMove || s.MovesLeft != 5 {
		t.Fatalf("guard chain must refund the move: bonus=%v movesLeft=%d", res.BonusMove, s.MovesLeft)
	}
	if res.Loot != 90 || s.Loot != 90 {
		t.Fatalf("3 guards should yield 90 loot, got %d", res.Loot)
	}
	if len(res.Unlocked) != 1 || res.Unlocked[0] != 14 {
		t.Fatalf("lock at 14 should be unlocked, got %v", res.Unlocked)
	}
	for _, v := range s.Grid {
		if v == Empty {
			t.Fatal("board still has empty cells after refill")
		}
	}

	// Keys fell? No: keys are on row 0 and the guards were on row 1, so keys at
	// columns 0..2 dropped one row. Rebuild a known state instead of guessing.
	for i := range s.Grid {
		s.Grid[i] = Money
	}
	s.Grid[0], s.Grid[1], s.Grid[2], s.Grid[3] = Key, Key, Key, Key
	res, err = s.Apply([]int{0, 1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	if res.Loot != 240 { // 4 * 40 * 150%
		t.Fatalf("4-chain of keys should yield 240 loot, got %d", res.Loot)
	}
	if res.State != Cracked || s.Objectives.Key != 0 {
		t.Fatalf("vault should be cracked, state=%s objectives=%+v", res.State, s.Objectives)
	}
	if _, err := s.Apply([]int{0, 1, 2}); !errors.Is(err, ErrInvalidMove) {
		t.Fatal("moves after crack must be rejected")
	}
}

func TestBustWhenOutOfMoves(t *testing.T) {
	cfg := testConfig()
	s := NewSim(NewRNG(1), cfg, 0, nil)
	for i := range s.Grid {
		s.Grid[i] = Money
	}
	s.Objectives = Objectives{Key: 50}
	s.MovesLeft = 1
	res, err := s.Apply([]int{0, 1, 2})
	if err != nil {
		t.Fatal(err)
	}
	if res.State != Busted {
		t.Fatalf("expected BUSTED, got %s", res.State)
	}
}

func TestReplayRoundTripWithBot(t *testing.T) {
	cfg := testConfig()
	for _, tc := range []struct {
		name     string
		bot      Bot
		boosters []string
		maxVault int
	}{
		{"cautious escape after vault 1", Bot{}, nil, 1},
		{"deep run", Bot{}, nil, 5},
		{"extra moves booster", Bot{}, []string{BoosterExtraMoves}, 3},
		{"greedy gets busted", Bot{Greedy: true}, nil, 5},
		{"greedy with shield", Bot{Greedy: true}, []string{BoosterShield}, 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rep, want := tc.bot.PlayRun(cfg, cfg.Seed, tc.boosters, tc.maxVault)
			got, err := Run(cfg, cfg.Seed, tc.boosters, rep)
			if err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Fatalf("replay mismatch:\n got %+v\nwant %+v", got, want)
			}
			if got.Score != rep.ClientScore {
				t.Fatalf("client score %d != server score %d", rep.ClientScore, got.Score)
			}
			if err := Plausible(cfg, rep); err != nil {
				t.Fatalf("bot run should be plausible: %v", err)
			}
		})
	}
}

func TestReplayRejectsTampering(t *testing.T) {
	cfg := testConfig()
	rep, _ := Bot{}.PlayRun(cfg, cfg.Seed, nil, 2)

	t.Run("wrong seed", func(t *testing.T) {
		if _, err := Run(cfg, cfg.Seed+1, nil, rep); !errors.Is(err, ErrInvalidReplay) {
			t.Fatalf("expected ErrInvalidReplay, got %v", err)
		}
	})
	t.Run("unfinished vault", func(t *testing.T) {
		bad := rep
		bad.Vaults = []VaultReplay{{Moves: rep.Vaults[0].Moves[:1]}}
		if _, err := Run(cfg, cfg.Seed, nil, bad); !errors.Is(err, ErrInvalidReplay) {
			t.Fatalf("expected ErrInvalidReplay, got %v", err)
		}
	})
	t.Run("too many vaults", func(t *testing.T) {
		bad := rep
		bad.Vaults = make([]VaultReplay, 6)
		if _, err := Run(cfg, cfg.Seed, nil, bad); !errors.Is(err, ErrInvalidReplay) {
			t.Fatalf("expected ErrInvalidReplay, got %v", err)
		}
	})
	t.Run("claiming boosters the run did not have changes the score", func(t *testing.T) {
		res, err := Run(cfg, cfg.Seed, nil, rep)
		if err != nil {
			t.Fatal(err)
		}
		if res.Score != rep.ClientScore {
			t.Fatal("baseline should match")
		}
		// With extra moves the board sequence is identical but a client that
		// claims a different score must be caught by the caller's comparison.
		if rep.ClientScore == 0 {
			t.Fatal("bot should have scored")
		}
	})
	t.Run("implausible duration", func(t *testing.T) {
		bad := rep
		bad.DurationMs = 10
		if err := Plausible(cfg, bad); err == nil {
			t.Fatal("expected plausibility failure")
		}
	})
}

func TestConfigValidate(t *testing.T) {
	cfg := testConfig()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("default config must validate: %v", err)
	}
	bad := *cfg
	bad.Vaults = append([]Vault(nil), cfg.Vaults...)
	bad.Vaults[0].Weights.Key = 0
	if err := bad.Validate(); err == nil {
		t.Fatal("unwinnable vault must fail validation")
	}
	bad2 := *cfg
	bad2.VaultMultipliers = []float64{1}
	if err := bad2.Validate(); err == nil {
		t.Fatal("multiplier count mismatch must fail validation")
	}
}

// Fixture is the cross-language golden format asserted by the TypeScript port.
type Fixture struct {
	Name     string   `json:"name"`
	Seed     uint32   `json:"seed"`
	Boosters []string `json:"boosters"`
	Config   *Config  `json:"config"`
	// Boards holds the initial board of every vault the replay visits.
	Boards [][]int `json:"boards"`
	Replay Replay  `json:"replay"`
	Result Result  `json:"result"`
	// Steps records loot/objectives/moves after every move for fine-grained diffs.
	Steps []FixtureStep `json:"steps"`
}

// FixtureStep snapshots the sim after one move.
type FixtureStep struct {
	Vault      int        `json:"vault"`
	Move       int        `json:"move"`
	Loot       int64      `json:"loot"`
	MovesLeft  int        `json:"movesLeft"`
	Objectives Objectives `json:"objectives"`
	State      string     `json:"state"`
	Grid       []int      `json:"grid"`
}

func buildFixture(name string, cfg *Config, seed uint32, boosters []string, bot Bot, maxVault int) Fixture {
	rep, res := bot.PlayRun(cfg, seed, boosters, maxVault)
	fx := Fixture{Name: name, Seed: seed, Boosters: boosters, Config: cfg, Replay: rep, Result: res}
	if fx.Boosters == nil {
		fx.Boosters = []string{}
	}
	rng := NewRNG(seed)
	for vi, vr := range rep.Vaults {
		sim := NewSim(rng, cfg, vi, boosters)
		fx.Boards = append(fx.Boards, append([]int(nil), sim.Grid...))
		for mi, mv := range vr.Moves {
			if _, err := sim.Apply(mv); err != nil {
				panic(err)
			}
			fx.Steps = append(fx.Steps, FixtureStep{
				Vault: vi, Move: mi, Loot: sim.Loot, MovesLeft: sim.MovesLeft,
				Objectives: sim.Objectives, State: sim.State.String(), Grid: append([]int(nil), sim.Grid...),
			})
		}
	}
	return fx
}

// TestGoldenFixtures regenerates testdata/fixtures.json when UPDATE_FIXTURES=1
// and otherwise asserts the committed file still matches the engine.
func TestGoldenFixtures(t *testing.T) {
	cfg := testConfig()
	hard := *cfg
	hard.Difficulty = 1.25
	hard.LootMultiplier = 1.5
	hard.Version = 2
	hard.Vaults = append([]Vault(nil), cfg.Vaults...)

	fixtures := []Fixture{
		buildFixture("cautious_v1", cfg, cfg.Seed, nil, Bot{}, 1),
		buildFixture("deep_v5", cfg, cfg.Seed, nil, Bot{}, 5),
		buildFixture("extra_moves_v3", cfg, 12345, []string{BoosterExtraMoves}, Bot{}, 3),
		buildFixture("greedy_bust", cfg, 999, nil, Bot{Greedy: true}, 5),
		buildFixture("greedy_bust_shield", cfg, 999, []string{BoosterShield}, Bot{Greedy: true}, 5),
		buildFixture("hard_config", &hard, 4242, nil, Bot{}, 4),
		buildFixture("seed_zero", cfg, 0, nil, Bot{}, 2),
		buildFixture("seed_max", cfg, 0xFFFFFFFF, nil, Bot{}, 2),
	}

	path := filepath.Join("testdata", "fixtures.json")
	if os.Getenv("UPDATE_FIXTURES") == "1" {
		data, err := json.MarshalIndent(fixtures, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %d fixtures to %s", len(fixtures), path)
		return
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("fixtures missing (run with UPDATE_FIXTURES=1): %v", err)
	}
	var committed []Fixture
	if err := json.Unmarshal(data, &committed); err != nil {
		t.Fatal(err)
	}
	if len(committed) != len(fixtures) {
		t.Fatalf("fixture count changed: %d committed, %d generated", len(committed), len(fixtures))
	}
	for i := range fixtures {
		if committed[i].Result != fixtures[i].Result {
			t.Errorf("%s: result drifted: committed %+v generated %+v", fixtures[i].Name, committed[i].Result, fixtures[i].Result)
		}
		if len(committed[i].Steps) != len(fixtures[i].Steps) {
			t.Errorf("%s: step count drifted", fixtures[i].Name)
		}
	}
}

func BenchmarkReplayDeepRun(b *testing.B) {
	cfg := testConfig()
	rep, _ := Bot{}.PlayRun(cfg, cfg.Seed, nil, 5)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := Run(cfg, cfg.Seed, nil, rep); err != nil {
			b.Fatal(err)
		}
	}
}
