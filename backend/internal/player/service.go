// Package player owns the profile lifecycle: creation, token issuance, life
// regeneration and the optimistic-concurrency mutation helper every other
// service uses to touch a profile.
package player

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/atakank/vault-rush/backend/internal/auth"
	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/experiment"
	"github.com/atakank/vault-rush/backend/internal/ids"
	"github.com/atakank/vault-rush/backend/internal/store"
	"github.com/atakank/vault-rush/backend/internal/telemetry"
)

// StartingCoins is granted to every new account.
const StartingCoins = 500

// MaxRetries bounds optimistic-concurrency retries in Mutate.
const MaxRetries = 4

// ErrRetriesExhausted is returned when a hot profile keeps losing races.
var ErrRetriesExhausted = errors.New("profile update retries exhausted")

// Service is the player service.
type Service struct {
	store  store.Store
	tokens *auth.Issuer
	bus    *telemetry.Bus
	regen  time.Duration
	now    func() time.Time
}

// New wires the service.
func New(st store.Store, tokens *auth.Issuer, bus *telemetry.Bus, lifeRegen time.Duration) *Service {
	return &Service{store: st, tokens: tokens, bus: bus, regen: lifeRegen, now: func() time.Time { return time.Now().UTC() }}
}

// WithClock overrides the clock (tests).
func (s *Service) WithClock(now func() time.Time) *Service { s.now = now; return s }

// Profile is the API view of a player.
type Profile struct {
	PlayerID        string         `json:"playerId"`
	DisplayName     string         `json:"displayName"`
	Coins           int64          `json:"coins"`
	Lives           int            `json:"lives"`
	MaxLives        int            `json:"maxLives"`
	NextLifeAt      *time.Time     `json:"nextLifeAt"`
	Boosters        map[string]int `json:"boosters"`
	Stats           domain.Stats   `json:"stats"`
	ExperimentGroup string         `json:"experimentGroup"`
	Version         int            `json:"version"`
	CreatedAt       time.Time      `json:"createdAt"`
}

// View projects a player into its API shape, applying pending regeneration
// without persisting it (reads stay cheap; the next mutation persists).
func (s *Service) View(p *domain.Player) Profile {
	c := p.Clone()
	ApplyRegen(c, s.now(), s.regen)
	var next *time.Time
	if c.Lives < c.MaxLives {
		t := c.LivesUpdatedAt.Add(s.regen)
		next = &t
	}
	if c.Boosters == nil {
		c.Boosters = map[string]int{}
	}
	return Profile{
		PlayerID: c.ID, DisplayName: c.DisplayName, Coins: c.Coins, Lives: c.Lives, MaxLives: c.MaxLives,
		NextLifeAt: next, Boosters: c.Boosters, Stats: c.Stats, ExperimentGroup: c.ExperimentGroup,
		Version: c.Version, CreatedAt: c.CreatedAt,
	}
}

// ApplyRegen advances lives according to elapsed time. It is deterministic
// given (player, now) so replaying it on read and on write agrees.
func ApplyRegen(p *domain.Player, now time.Time, regen time.Duration) {
	if regen <= 0 {
		return
	}
	if p.Lives >= p.MaxLives {
		p.LivesUpdatedAt = now
		return
	}
	if p.LivesUpdatedAt.IsZero() {
		p.LivesUpdatedAt = now
		return
	}
	gained := int(now.Sub(p.LivesUpdatedAt) / regen)
	if gained <= 0 {
		return
	}
	p.Lives += gained
	p.LivesUpdatedAt = p.LivesUpdatedAt.Add(time.Duration(gained) * regen)
	if p.Lives >= p.MaxLives {
		p.Lives = p.MaxLives
		p.LivesUpdatedAt = now
	}
}

// CreateOrResume returns the player bound to a device, creating it on first
// sight. Idempotent per device so a reinstall never duplicates accounts.
func (s *Service) CreateOrResume(ctx context.Context, deviceID, displayName string) (*domain.Player, string, bool, error) {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return nil, "", false, fmt.Errorf("deviceId is required")
	}
	if existing, err := s.store.Players().GetByDevice(ctx, deviceID); err == nil {
		return existing, s.tokens.Issue(existing.ID), false, nil
	} else if !errors.Is(err, domain.ErrNotFound) {
		return nil, "", false, err
	}

	displayName = sanitizeName(displayName)
	now := s.now()
	id := ids.New("plr")
	group := experiment.Assign(id)
	p := &domain.Player{
		ID: id, DeviceID: deviceID, DisplayName: displayName, Coins: StartingCoins,
		MaxLives: experiment.MaxLives(group), Boosters: map[string]int{"extra_moves": 1, "shield": 1},
		ExperimentGroup: group, Version: 1, CreatedAt: now, UpdatedAt: now, LivesUpdatedAt: now,
	}
	p.Lives = p.MaxLives
	if err := s.store.Players().Create(ctx, p); err != nil {
		if errors.Is(err, domain.ErrAlreadyExists) {
			// Lost a race with the same device: resume the winner.
			if existing, gerr := s.store.Players().GetByDevice(ctx, deviceID); gerr == nil {
				return existing, s.tokens.Issue(existing.ID), false, nil
			}
		}
		return nil, "", false, err
	}
	if s.bus != nil {
		s.bus.Publish(telemetry.Event{ID: ids.New("evt"), Type: telemetry.PlayerCreated, PlayerID: p.ID, Group: group, Name: displayName})
	}
	return p, s.tokens.Issue(p.ID), true, nil
}

func sanitizeName(n string) string {
	n = strings.TrimSpace(n)
	if n == "" {
		return "Agent " + ids.New("")[1:5]
	}
	if len(n) > 20 {
		n = n[:20]
	}
	return n
}

// Get fetches a player.
func (s *Service) Get(ctx context.Context, id string) (*domain.Player, error) {
	return s.store.Players().Get(ctx, id)
}

// Token issues a bearer token for a player id.
func (s *Service) Token(playerID string) string { return s.tokens.Issue(playerID) }

// Mutate reads the profile, applies regeneration and fn, then writes with a
// version check. A lost race re-reads and re-applies fn — which is exactly why
// fn must be a pure decision on the freshly read state (e.g. "enough coins?").
func (s *Service) Mutate(ctx context.Context, id string, fn func(p *domain.Player) error) (*domain.Player, error) {
	var lastErr error
	for attempt := 0; attempt < MaxRetries; attempt++ {
		p, err := s.store.Players().Get(ctx, id)
		if err != nil {
			return nil, err
		}
		ApplyRegen(p, s.now(), s.regen)
		if err := fn(p); err != nil {
			return nil, err
		}
		if err := s.store.Players().Update(ctx, p); err != nil {
			if errors.Is(err, domain.ErrVersionConflict) {
				lastErr = err
				continue
			}
			return nil, err
		}
		return p, nil
	}
	return nil, fmt.Errorf("%w: %v", ErrRetriesExhausted, lastErr)
}
