// Package memory is an in-process Store used for unit tests and for running
// the whole platform with zero external dependencies (STORAGE=memory).
//
// It mirrors DynamoDB semantics precisely — conditional writes, version
// checks, immutability of config versions — so services behave identically
// against either backend.
package memory

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/store"
	"github.com/atakank/vault-rush/backend/pkg/engine"
)

// Store is the in-memory implementation of store.Store.
type Store struct {
	mu          sync.RWMutex
	players     map[string]*domain.Player
	devices     map[string]string // deviceID -> playerID
	runs        map[string]*domain.Run
	runsByOwner map[string][]string
	events      map[string]*domain.EventMeta
	configs     map[string]map[int]*engine.Config
	rewards     map[string]*domain.Reward
	rewardOwner map[string][]string
	idem        map[string]*domain.IdempotencyRecord
}

// New creates an empty store.
func New() *Store {
	return &Store{
		players:     map[string]*domain.Player{},
		devices:     map[string]string{},
		runs:        map[string]*domain.Run{},
		runsByOwner: map[string][]string{},
		events:      map[string]*domain.EventMeta{},
		configs:     map[string]map[int]*engine.Config{},
		rewards:     map[string]*domain.Reward{},
		rewardOwner: map[string][]string{},
		idem:        map[string]*domain.IdempotencyRecord{},
	}
}

func (s *Store) Players() store.Players         { return (*players)(s) }
func (s *Store) Runs() store.Runs               { return (*runs)(s) }
func (s *Store) Events() store.Events           { return (*events)(s) }
func (s *Store) Rewards() store.Rewards         { return (*rewards)(s) }
func (s *Store) Idempotency() store.Idempotency { return (*idem)(s) }
func (s *Store) Ping(context.Context) error     { return nil }
func (s *Store) Name() string                   { return "memory" }
func (s *Store) Close() error                   { return nil }

func runKey(playerID, runID string) string       { return playerID + "/" + runID }
func rewardKey(playerID, rewardID string) string { return playerID + "/" + rewardID }
func idemKey(playerID, key string) string        { return playerID + "/" + key }

// ---- players ----

type players Store

func (p *players) Create(_ context.Context, pl *domain.Player) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.players[pl.ID]; ok {
		return domain.ErrAlreadyExists
	}
	if pl.DeviceID != "" {
		if _, ok := p.devices[pl.DeviceID]; ok {
			return domain.ErrAlreadyExists
		}
		p.devices[pl.DeviceID] = pl.ID
	}
	p.players[pl.ID] = pl.Clone()
	return nil
}

func (p *players) Get(_ context.Context, id string) (*domain.Player, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	pl, ok := p.players[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return pl.Clone(), nil
}

func (p *players) GetByDevice(_ context.Context, deviceID string) (*domain.Player, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	id, ok := p.devices[deviceID]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return p.players[id].Clone(), nil
}

func (p *players) Update(_ context.Context, pl *domain.Player) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	cur, ok := p.players[pl.ID]
	if !ok {
		return domain.ErrNotFound
	}
	if cur.Version != pl.Version {
		return domain.ErrVersionConflict
	}
	pl.Version++
	pl.UpdatedAt = time.Now().UTC()
	p.players[pl.ID] = pl.Clone()
	return nil
}

// ---- runs ----

type runs Store

func (r *runs) Put(_ context.Context, run *domain.Run) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	k := runKey(run.PlayerID, run.ID)
	if _, exists := r.runs[k]; !exists {
		r.runsByOwner[run.PlayerID] = append(r.runsByOwner[run.PlayerID], run.ID)
	}
	c := *run
	r.runs[k] = &c
	return nil
}

func (r *runs) Get(_ context.Context, playerID, runID string) (*domain.Run, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	run, ok := r.runs[runKey(playerID, runID)]
	if !ok {
		return nil, domain.ErrNotFound
	}
	c := *run
	return &c, nil
}

func (r *runs) Finish(_ context.Context, run *domain.Run) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	cur, ok := r.runs[runKey(run.PlayerID, run.ID)]
	if !ok {
		return domain.ErrNotFound
	}
	if cur.Status != domain.RunActive {
		return domain.ErrConflict
	}
	c := *run
	c.Status = domain.RunFinished
	r.runs[runKey(run.PlayerID, run.ID)] = &c
	run.Status = domain.RunFinished
	return nil
}

func (r *runs) ListByPlayer(_ context.Context, playerID string, limit int) ([]*domain.Run, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := r.runsByOwner[playerID]
	out := make([]*domain.Run, 0, len(ids))
	for i := len(ids) - 1; i >= 0 && (limit <= 0 || len(out) < limit); i-- {
		c := *r.runs[runKey(playerID, ids[i])]
		out = append(out, &c)
	}
	return out, nil
}

// ---- events ----

type events Store

func (e *events) CreateMeta(_ context.Context, m *domain.EventMeta) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.events[m.ID]; ok {
		return domain.ErrAlreadyExists
	}
	c := *m
	e.events[m.ID] = &c
	return nil
}

func (e *events) UpdateMeta(_ context.Context, m *domain.EventMeta) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.events[m.ID]; !ok {
		return domain.ErrNotFound
	}
	c := *m
	e.events[m.ID] = &c
	return nil
}

func (e *events) GetMeta(_ context.Context, id string) (*domain.EventMeta, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	m, ok := e.events[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	c := *m
	return &c, nil
}

func (e *events) ListMeta(_ context.Context, from, to time.Time) ([]*domain.EventMeta, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	var out []*domain.EventMeta
	for _, m := range e.events {
		if m.EndsAt.After(from) && m.StartsAt.Before(to) {
			c := *m
			out = append(out, &c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartsAt.Before(out[j].StartsAt) })
	return out, nil
}

func (e *events) PutConfig(_ context.Context, cfg *engine.Config) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	vs, ok := e.configs[cfg.EventID]
	if !ok {
		vs = map[int]*engine.Config{}
		e.configs[cfg.EventID] = vs
	}
	if _, exists := vs[cfg.Version]; exists {
		return domain.ErrAlreadyExists
	}
	vs[cfg.Version] = cloneConfig(cfg)
	return nil
}

func (e *events) GetConfig(_ context.Context, eventID string, version int) (*engine.Config, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	cfg, ok := e.configs[eventID][version]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return cloneConfig(cfg), nil
}

func (e *events) ListConfigVersions(_ context.Context, eventID string) ([]domain.ConfigVersionInfo, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	var out []domain.ConfigVersionInfo
	for _, c := range e.configs[eventID] {
		out = append(out, domain.ConfigVersionInfo{Version: c.Version, CreatedAt: c.CreatedAt, CreatedBy: c.CreatedBy, Note: c.Note})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version > out[j].Version })
	return out, nil
}

func cloneConfig(c *engine.Config) *engine.Config {
	cp := *c
	cp.VaultMultipliers = append([]float64(nil), c.VaultMultipliers...)
	cp.Vaults = append([]engine.Vault(nil), c.Vaults...)
	return &cp
}

// ---- rewards ----

type rewards Store

func (r *rewards) Put(_ context.Context, rw *domain.Reward) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	k := rewardKey(rw.PlayerID, rw.ID)
	if _, exists := r.rewards[k]; !exists {
		r.rewardOwner[rw.PlayerID] = append(r.rewardOwner[rw.PlayerID], rw.ID)
	}
	c := *rw
	r.rewards[k] = &c
	return nil
}

func (r *rewards) Create(_ context.Context, rw *domain.Reward) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	k := rewardKey(rw.PlayerID, rw.ID)
	if _, exists := r.rewards[k]; exists {
		return domain.ErrAlreadyExists
	}
	r.rewardOwner[rw.PlayerID] = append(r.rewardOwner[rw.PlayerID], rw.ID)
	c := *rw
	r.rewards[k] = &c
	return nil
}

func (r *rewards) Get(_ context.Context, playerID, rewardID string) (*domain.Reward, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rw, ok := r.rewards[rewardKey(playerID, rewardID)]
	if !ok {
		return nil, domain.ErrNotFound
	}
	c := *rw
	return &c, nil
}

func (r *rewards) Claim(_ context.Context, playerID, rewardID string, at time.Time) (*domain.Reward, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rw, ok := r.rewards[rewardKey(playerID, rewardID)]
	if !ok {
		return nil, domain.ErrNotFound
	}
	if rw.Status != domain.RewardPending {
		return nil, domain.ErrConflict
	}
	rw.Status = domain.RewardClaimed
	t := at
	rw.ClaimedAt = &t
	c := *rw
	return &c, nil
}

func (r *rewards) ListPending(_ context.Context, playerID string) ([]*domain.Reward, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []*domain.Reward
	for _, id := range r.rewardOwner[playerID] {
		rw := r.rewards[rewardKey(playerID, id)]
		if rw.Status == domain.RewardPending {
			c := *rw
			out = append(out, &c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// ---- idempotency ----

type idem Store

func (i *idem) Begin(_ context.Context, playerID, key string, ttl time.Duration) (*domain.IdempotencyRecord, bool, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	now := time.Now().UTC()
	k := idemKey(playerID, key)
	if rec, ok := i.idem[k]; ok && rec.ExpiresAt.After(now) {
		c := *rec
		return &c, false, nil
	}
	rec := &domain.IdempotencyRecord{PlayerID: playerID, Key: key, State: domain.IdempotencyInProgress, CreatedAt: now, ExpiresAt: now.Add(ttl)}
	i.idem[k] = rec
	c := *rec
	return &c, true, nil
}

func (i *idem) Complete(_ context.Context, playerID, key string, status int, body []byte) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	rec, ok := i.idem[idemKey(playerID, key)]
	if !ok {
		return domain.ErrNotFound
	}
	rec.State = domain.IdempotencyDone
	rec.StatusCode = status
	rec.Body = append([]byte(nil), body...)
	return nil
}

func (i *idem) Abort(_ context.Context, playerID, key string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	delete(i.idem, idemKey(playerID, key))
	return nil
}
