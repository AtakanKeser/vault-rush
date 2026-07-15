// Package experiment implements deterministic A/B assignment. A player is
// always in the same group because assignment is a pure function of the id,
// so no assignment table is needed and every service can recompute it.
package experiment

import "hash/fnv"

// LivesTest is the only live experiment: does a bigger life pool increase
// runs per user without hurting completion?
const LivesTest = "lives_test"

// Definition describes an experiment for the LiveOps panel.
type Definition struct {
	ID          string                    `json:"id"`
	Description string                    `json:"description"`
	Groups      map[string]map[string]any `json:"groups"`
	Assignment  string                    `json:"assignment"`
}

// Definitions lists active experiments.
func Definitions() []Definition {
	return []Definition{{
		ID:          LivesTest,
		Description: "Max lives 5 (control) vs 7 (treatment)",
		Groups: map[string]map[string]any{
			"A": {"maxLives": 5},
			"B": {"maxLives": 7},
		},
		Assignment: "fnv1a32(playerId) % 2 == 0 → A, else B",
	}}
}

// Assign returns "A" or "B" for a player id.
func Assign(playerID string) string {
	h := fnv.New32a()
	h.Write([]byte(playerID))
	if h.Sum32()%2 == 0 {
		return "A"
	}
	return "B"
}

// MaxLives is the treatment applied by the lives experiment.
func MaxLives(group string) int {
	if group == "B" {
		return 7
	}
	return 5
}
