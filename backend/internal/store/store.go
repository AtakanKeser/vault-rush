// Package store defines the persistence ports. Two adapters exist: an
// in-memory implementation for unit tests / zero-dependency local runs and a
// DynamoDB single-table implementation for production.
package store

import (
	"context"
	"time"

	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/pkg/engine"
)

// Players persists profiles with optimistic concurrency.
type Players interface {
	// Create fails with domain.ErrAlreadyExists when the id or device is taken.
	Create(ctx context.Context, p *domain.Player) error
	Get(ctx context.Context, id string) (*domain.Player, error)
	GetByDevice(ctx context.Context, deviceID string) (*domain.Player, error)
	// Update asserts p.Version matches the stored version, then persists with
	// Version+1 and mutates p.Version accordingly. Returns
	// domain.ErrVersionConflict on a lost race.
	Update(ctx context.Context, p *domain.Player) error
}

// Runs persists heist runs.
type Runs interface {
	Put(ctx context.Context, r *domain.Run) error
	Get(ctx context.Context, playerID, runID string) (*domain.Run, error)
	// Finish flips ACTIVE → FINISHED atomically; a second call returns
	// domain.ErrConflict so a run can never be scored twice.
	Finish(ctx context.Context, r *domain.Run) error
	ListByPlayer(ctx context.Context, playerID string, limit int) ([]*domain.Run, error)
}

// Events persists event headers and immutable config versions.
type Events interface {
	// CreateMeta fails with domain.ErrAlreadyExists if the event exists.
	CreateMeta(ctx context.Context, m *domain.EventMeta) error
	UpdateMeta(ctx context.Context, m *domain.EventMeta) error
	GetMeta(ctx context.Context, id string) (*domain.EventMeta, error)
	// ListMeta returns events whose window intersects [from, to).
	ListMeta(ctx context.Context, from, to time.Time) ([]*domain.EventMeta, error)
	// PutConfig fails with domain.ErrAlreadyExists if the version exists;
	// versions are never overwritten.
	PutConfig(ctx context.Context, cfg *engine.Config) error
	GetConfig(ctx context.Context, eventID string, version int) (*engine.Config, error)
	ListConfigVersions(ctx context.Context, eventID string) ([]domain.ConfigVersionInfo, error)
}

// Rewards persists claimable grants.
type Rewards interface {
	Put(ctx context.Context, r *domain.Reward) error
	// Create fails with domain.ErrAlreadyExists when the reward id is taken; it
	// lets grants be idempotent in a single round-trip.
	Create(ctx context.Context, r *domain.Reward) error
	Get(ctx context.Context, playerID, rewardID string) (*domain.Reward, error)
	// Claim flips PENDING → CLAIMED atomically. Concurrent claimers lose with
	// domain.ErrConflict, which is what makes reward delivery exactly-once.
	Claim(ctx context.Context, playerID, rewardID string, at time.Time) (*domain.Reward, error)
	ListPending(ctx context.Context, playerID string) ([]*domain.Reward, error)
}

// Idempotency stores request fingerprints and their responses.
type Idempotency interface {
	// Begin registers key as IN_PROGRESS. When a record already exists it is
	// returned with acquired=false.
	Begin(ctx context.Context, playerID, key string, ttl time.Duration) (rec *domain.IdempotencyRecord, acquired bool, err error)
	Complete(ctx context.Context, playerID, key string, status int, body []byte) error
	// Abort removes an IN_PROGRESS record so the client may retry after a failure.
	Abort(ctx context.Context, playerID, key string) error
}

// Store aggregates all repositories behind one connection.
type Store interface {
	Players() Players
	Runs() Runs
	Events() Events
	Rewards() Rewards
	Idempotency() Idempotency
	Ping(ctx context.Context) error
	Name() string
	Close() error
}
