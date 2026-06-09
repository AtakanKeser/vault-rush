// Package domain holds the persistent entities shared by every service and
// storage backend. It deliberately has no dependencies on transport or storage.
package domain

import (
	"errors"
	"time"

	"github.com/atakank/vault-rush/backend/pkg/engine"
)

// Sentinel errors returned by stores; services translate them into API errors.
var (
	ErrNotFound        = errors.New("not found")
	ErrAlreadyExists   = errors.New("already exists")
	ErrVersionConflict = errors.New("version conflict")
	ErrConflict        = errors.New("conflict")
)

// Stats are lifetime counters on a player profile.
type Stats struct {
	Runs          int64 `json:"runs"`
	BestScore     int64 `json:"bestScore"`
	TotalLoot     int64 `json:"totalLoot"`
	VaultsCracked int64 `json:"vaultsCracked"`
}

// Player is the account/progression record. Version implements optimistic
// concurrency: every write asserts the version it read and bumps it.
type Player struct {
	ID              string         `json:"playerId"`
	DeviceID        string         `json:"-"`
	DisplayName     string         `json:"displayName"`
	Coins           int64          `json:"coins"`
	Lives           int            `json:"lives"`
	MaxLives        int            `json:"maxLives"`
	LivesUpdatedAt  time.Time      `json:"-"`
	Boosters        map[string]int `json:"boosters"`
	Stats           Stats          `json:"stats"`
	ExperimentGroup string         `json:"experimentGroup"`
	Version         int            `json:"version"`
	CreatedAt       time.Time      `json:"createdAt"`
	UpdatedAt       time.Time      `json:"updatedAt"`
}

// Clone returns a deep copy so callers can mutate freely.
func (p *Player) Clone() *Player {
	c := *p
	c.Boosters = make(map[string]int, len(p.Boosters))
	for k, v := range p.Boosters {
		c.Boosters[k] = v
	}
	return &c
}

// RunStatus is the lifecycle of a heist run.
type RunStatus string

const (
	RunActive   RunStatus = "ACTIVE"
	RunFinished RunStatus = "FINISHED"
)

// Run is what the server keeps about a heist: not the board, just enough to
// replay it deterministically.
type Run struct {
	ID            string         `json:"runId"`
	PlayerID      string         `json:"playerId"`
	EventID       string         `json:"eventId"`
	Seed          uint32         `json:"seed"`
	ConfigVersion int            `json:"configVersion"`
	Boosters      []string       `json:"boosters"`
	Status        RunStatus      `json:"status"`
	StartedAt     time.Time      `json:"startedAt"`
	ExpiresAt     time.Time      `json:"expiresAt"`
	FinishedAt    *time.Time     `json:"finishedAt,omitempty"`
	Result        *engine.Result `json:"result,omitempty"`
	DurationMs    int64          `json:"durationMs,omitempty"`
}

// EventStatus is derived from the clock, never stored.
type EventStatus string

const (
	EventUpcoming EventStatus = "UPCOMING"
	EventActive   EventStatus = "ACTIVE"
	EventEnded    EventStatus = "ENDED"
)

// EventMeta is the mutable header of a daily heist; configs live separately
// and are immutable per version.
type EventMeta struct {
	ID                 string    `json:"eventId"`
	Name               string    `json:"name"`
	Theme              string    `json:"theme"`
	StartsAt           time.Time `json:"startsAt"`
	EndsAt             time.Time `json:"endsAt"`
	ConfigVersion      int       `json:"configVersion"`
	RewardsDistributed bool      `json:"rewardsDistributed"`
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

// StatusAt derives the lifecycle status for a point in time.
func (e *EventMeta) StatusAt(now time.Time) EventStatus {
	switch {
	case now.Before(e.StartsAt):
		return EventUpcoming
	case !now.Before(e.EndsAt):
		return EventEnded
	default:
		return EventActive
	}
}

// ConfigVersionInfo is the summary shown in the LiveOps version history.
type ConfigVersionInfo struct {
	Version   int       `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
	CreatedBy string    `json:"createdBy,omitempty"`
	Note      string    `json:"note,omitempty"`
}

// RewardStatus is PENDING until the player claims it exactly once.
type RewardStatus string

const (
	RewardPending RewardStatus = "PENDING"
	RewardClaimed RewardStatus = "CLAIMED"
)

// Reward types.
const (
	RewardTypeRunLoot     = "RUN_LOOT"
	RewardTypeLeaderboard = "LEADERBOARD"
)

// Reward is a claimable grant.
type Reward struct {
	ID        string         `json:"rewardId"`
	PlayerID  string         `json:"playerId"`
	Type      string         `json:"type"`
	Title     string         `json:"title"`
	Coins     int64          `json:"coins"`
	Boosters  map[string]int `json:"boosters,omitempty"`
	Status    RewardStatus   `json:"status"`
	EventID   string         `json:"eventId,omitempty"`
	RunID     string         `json:"runId,omitempty"`
	Rank      int64          `json:"rank,omitempty"`
	CreatedAt time.Time      `json:"createdAt"`
	ClaimedAt *time.Time     `json:"claimedAt,omitempty"`
}

// IdempotencyState tracks an in-flight or completed request.
type IdempotencyState string

const (
	IdempotencyInProgress IdempotencyState = "IN_PROGRESS"
	IdempotencyDone       IdempotencyState = "DONE"
)

// IdempotencyRecord stores the response of a completed mutating request so a
// retry after a lost response is answered identically without side effects.
type IdempotencyRecord struct {
	PlayerID   string           `json:"playerId"`
	Key        string           `json:"key"`
	State      IdempotencyState `json:"state"`
	StatusCode int              `json:"statusCode"`
	Body       []byte           `json:"body"`
	CreatedAt  time.Time        `json:"createdAt"`
	ExpiresAt  time.Time        `json:"expiresAt"`
}
