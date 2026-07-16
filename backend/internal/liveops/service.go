// Package liveops owns events and their versioned configurations.
//
// Configs are immutable: publishing creates version N+1 and moves the event's
// pointer. Runs pin the version they started with, so a LiveOps change never
// alters a heist in progress. Hot configs are cached in-process (immutable,
// so no invalidation needed) and in the shared KV cache.
package liveops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"sync"
	"time"

	"github.com/atakank/vault-rush/backend/internal/cache"
	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/store"
	"github.com/atakank/vault-rush/backend/pkg/engine"
)

// Theme is a museum skin for a daily heist.
type Theme struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Themes rotate by day of year.
var Themes = []Theme{
	{"louvre", "Louvre Diamond Heist"},
	{"met", "Met Gala Vault Job"},
	{"british", "British Museum Break-in"},
	{"prado", "Prado Night Raid"},
	{"hermitage", "Hermitage Winter Score"},
	{"uffizi", "Uffizi Masterpiece Grab"},
	{"vatican", "Vatican Archive Run"},
}

const (
	metaTTL   = 5 * time.Second
	configTTL = time.Hour
)

// ErrValidation wraps config validation problems (HTTP 400).
var ErrValidation = errors.New("config validation failed")

// Service is the LiveOps service.
type Service struct {
	store store.Store
	kv    cache.KV
	salt  string
	now   func() time.Time

	mu      sync.RWMutex
	configs map[string]*engine.Config // immutable per key → cache forever
	metas   map[string]cachedMeta
}

type cachedMeta struct {
	meta *domain.EventMeta
	exp  time.Time
}

// New wires the service.
func New(st store.Store, kv cache.KV, seedSalt string) *Service {
	return &Service{
		store: st, kv: kv, salt: seedSalt,
		now:     func() time.Time { return time.Now().UTC() },
		configs: map[string]*engine.Config{},
		metas:   map[string]cachedMeta{},
	}
}

// WithClock overrides the clock (tests).
func (s *Service) WithClock(now func() time.Time) *Service { s.now = now; return s }

// Now exposes the clock for handlers computing statuses.
func (s *Service) Now() time.Time { return s.now() }

// DailyID derives the deterministic event id for a UTC day.
func DailyID(day time.Time) (string, Theme) {
	day = day.UTC()
	t := Themes[day.YearDay()%len(Themes)]
	return fmt.Sprintf("%s_%s", t.ID, day.Format("2006_01_02")), t
}

// Seed derives a stable board seed for an event id.
func (s *Service) Seed(eventID string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(eventID + ":" + s.salt))
	return h.Sum32()
}

// EnsureDaily provisions the event for a day if it does not exist and returns it.
func (s *Service) EnsureDaily(ctx context.Context, day time.Time) (*domain.EventMeta, error) {
	id, theme := DailyID(day)
	if m, err := s.GetMeta(ctx, id); err == nil {
		return m, nil
	} else if !errors.Is(err, domain.ErrNotFound) {
		return nil, err
	}
	start := time.Date(day.UTC().Year(), day.UTC().Month(), day.UTC().Day(), 0, 0, 0, 0, time.UTC)
	now := s.now()
	cfg := engine.DefaultConfig(id, s.Seed(id), now)
	meta := &domain.EventMeta{
		ID: id, Name: theme.Name, Theme: theme.ID,
		StartsAt: start, EndsAt: start.Add(24 * time.Hour),
		ConfigVersion: 1, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.Create(ctx, meta, &cfg); err != nil {
		if errors.Is(err, domain.ErrAlreadyExists) {
			return s.GetMeta(ctx, id)
		}
		return nil, err
	}
	return meta, nil
}

// Create persists a brand-new event with its first config version.
func (s *Service) Create(ctx context.Context, meta *domain.EventMeta, cfg *engine.Config) error {
	cfg.EventID = meta.ID
	cfg.Version = 1
	if cfg.CreatedAt.IsZero() {
		cfg.CreatedAt = s.now()
	}
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("%w: %v", ErrValidation, err)
	}
	if !meta.EndsAt.After(meta.StartsAt) {
		return fmt.Errorf("%w: endsAt must be after startsAt", ErrValidation)
	}
	meta.ConfigVersion = 1
	if err := s.store.Events().CreateMeta(ctx, meta); err != nil {
		return err
	}
	if err := s.store.Events().PutConfig(ctx, cfg); err != nil && !errors.Is(err, domain.ErrAlreadyExists) {
		return err
	}
	s.rememberConfig(cfg)
	return nil
}

// Current returns today's event and its live config, provisioning on demand.
func (s *Service) Current(ctx context.Context) (*domain.EventMeta, *engine.Config, error) {
	meta, err := s.EnsureDaily(ctx, s.now())
	if err != nil {
		return nil, nil, err
	}
	cfg, err := s.GetConfig(ctx, meta.ID, meta.ConfigVersion)
	if err != nil {
		return nil, nil, err
	}
	return meta, cfg, nil
}

// GetMeta fetches an event header through the short-lived caches.
func (s *Service) GetMeta(ctx context.Context, id string) (*domain.EventMeta, error) {
	now := s.now()
	s.mu.RLock()
	c, ok := s.metas[id]
	s.mu.RUnlock()
	if ok && c.exp.After(now) {
		cp := *c.meta
		return &cp, nil
	}
	if s.kv != nil {
		if b, hit, err := s.kv.Get(ctx, "event:meta:"+id); err == nil && hit {
			var m domain.EventMeta
			if json.Unmarshal(b, &m) == nil {
				s.rememberMeta(&m)
				return &m, nil
			}
		}
	}
	m, err := s.store.Events().GetMeta(ctx, id)
	if err != nil {
		return nil, err
	}
	s.rememberMeta(m)
	if s.kv != nil {
		if b, err := json.Marshal(m); err == nil {
			_ = s.kv.Set(ctx, "event:meta:"+id, b, metaTTL)
		}
	}
	return m, nil
}

func (s *Service) rememberMeta(m *domain.EventMeta) {
	cp := *m
	s.mu.Lock()
	s.metas[m.ID] = cachedMeta{meta: &cp, exp: s.now().Add(metaTTL)}
	s.mu.Unlock()
}

func (s *Service) forgetMeta(ctx context.Context, id string) {
	s.mu.Lock()
	delete(s.metas, id)
	s.mu.Unlock()
	if s.kv != nil {
		_ = s.kv.Del(ctx, "event:meta:"+id)
	}
}

func configKey(eventID string, version int) string {
	return fmt.Sprintf("event:config:%s:%d", eventID, version)
}

// GetConfig fetches an immutable config version through the caches.
func (s *Service) GetConfig(ctx context.Context, eventID string, version int) (*engine.Config, error) {
	key := configKey(eventID, version)
	s.mu.RLock()
	c, ok := s.configs[key]
	s.mu.RUnlock()
	if ok {
		return c, nil
	}
	if s.kv != nil {
		if b, hit, err := s.kv.Get(ctx, key); err == nil && hit {
			var cfg engine.Config
			if json.Unmarshal(b, &cfg) == nil {
				s.rememberConfig(&cfg)
				return &cfg, nil
			}
		}
	}
	cfg, err := s.store.Events().GetConfig(ctx, eventID, version)
	if err != nil {
		return nil, err
	}
	s.rememberConfig(cfg)
	if s.kv != nil {
		if b, err := json.Marshal(cfg); err == nil {
			_ = s.kv.Set(ctx, key, b, configTTL)
		}
	}
	return cfg, nil
}

func (s *Service) rememberConfig(cfg *engine.Config) {
	s.mu.Lock()
	if len(s.configs) > 512 { // crude bound; configs are tiny
		s.configs = map[string]*engine.Config{}
	}
	s.configs[configKey(cfg.EventID, cfg.Version)] = cfg
	s.mu.Unlock()
}

// PublishConfig validates and stores a new version, then moves the pointer.
func (s *Service) PublishConfig(ctx context.Context, eventID string, cfg engine.Config, note, by string) (*domain.EventMeta, *engine.Config, error) {
	cfg.EventID = eventID
	cfg.Note = note
	cfg.CreatedBy = by
	cfg.CreatedAt = s.now()
	if err := cfg.Validate(); err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrValidation, err)
	}
	for attempt := 0; attempt < 5; attempt++ {
		meta, err := s.store.Events().GetMeta(ctx, eventID)
		if err != nil {
			return nil, nil, err
		}
		cfg.Version = meta.ConfigVersion + 1
		if err := s.store.Events().PutConfig(ctx, &cfg); err != nil {
			if errors.Is(err, domain.ErrAlreadyExists) {
				continue // concurrent publisher won this version number; take the next
			}
			return nil, nil, err
		}
		meta.ConfigVersion = cfg.Version
		meta.UpdatedAt = s.now()
		if err := s.store.Events().UpdateMeta(ctx, meta); err != nil {
			return nil, nil, err
		}
		s.forgetMeta(ctx, eventID)
		s.rememberConfig(&cfg)
		return meta, &cfg, nil
	}
	return nil, nil, fmt.Errorf("could not allocate a config version for %s", eventID)
}

// UpdateMeta persists header changes (name, window, rewards flag).
func (s *Service) UpdateMeta(ctx context.Context, meta *domain.EventMeta) error {
	meta.UpdatedAt = s.now()
	if err := s.store.Events().UpdateMeta(ctx, meta); err != nil {
		return err
	}
	s.forgetMeta(ctx, meta.ID)
	return nil
}

// ListWindow returns events from yesterday through +days, provisioning the
// daily ones so LiveOps can edit tomorrow's heist before it goes live.
func (s *Service) ListWindow(ctx context.Context, days int) ([]*domain.EventMeta, error) {
	if days < 0 {
		days = 0
	}
	if days > 30 {
		days = 30
	}
	today := s.now().Truncate(24 * time.Hour)
	for d := -1; d <= days; d++ {
		if _, err := s.EnsureDaily(ctx, today.AddDate(0, 0, d)); err != nil {
			return nil, err
		}
	}
	return s.store.Events().ListMeta(ctx, today.AddDate(0, 0, -1), today.AddDate(0, 0, days+1))
}

// Versions lists the config history of an event.
func (s *Service) Versions(ctx context.Context, eventID string) ([]domain.ConfigVersionInfo, error) {
	return s.store.Events().ListConfigVersions(ctx, eventID)
}

// EndedUndistributed returns ended events that still owe leaderboard rewards.
func (s *Service) EndedUndistributed(ctx context.Context, lookback time.Duration) ([]*domain.EventMeta, error) {
	now := s.now()
	metas, err := s.store.Events().ListMeta(ctx, now.Add(-lookback), now)
	if err != nil {
		return nil, err
	}
	var out []*domain.EventMeta
	for _, m := range metas {
		if m.StatusAt(now) == domain.EventEnded && !m.RewardsDistributed {
			out = append(out, m)
		}
	}
	return out, nil
}
