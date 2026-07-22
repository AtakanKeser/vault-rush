// Package leaderboard reads rankings from the sorted-set cache and updates
// them from the telemetry stream (eventually consistent by design).
package leaderboard

import (
	"context"
	"fmt"

	"github.com/atakank/vault-rush/backend/internal/cache"
	"github.com/atakank/vault-rush/backend/internal/telemetry"
)

// Board is the API response.
type Board struct {
	EventID string        `json:"eventId"`
	Total   int64         `json:"total"`
	Entries []cache.Entry `json:"entries"`
	Me      *cache.Entry  `json:"me"`
}

// Service reads leaderboards.
type Service struct {
	lb cache.Leaderboard
}

// New wires the service.
func New(lb cache.Leaderboard) *Service { return &Service{lb: lb} }

// Global returns the top N and the caller's own position.
func (s *Service) Global(ctx context.Context, eventID, playerID string, limit int) (*Board, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	entries, err := s.lb.Top(ctx, eventID, limit)
	if err != nil {
		return nil, fmt.Errorf("leaderboard top: %w", err)
	}
	if entries == nil {
		entries = []cache.Entry{}
	}
	total, err := s.lb.Count(ctx, eventID)
	if err != nil {
		return nil, fmt.Errorf("leaderboard count: %w", err)
	}
	b := &Board{EventID: eventID, Total: total, Entries: entries}
	if playerID != "" {
		if me, err := s.me(ctx, eventID, playerID); err == nil {
			b.Me = me
		}
	}
	return b, nil
}

// Rivals returns the players immediately around the caller.
func (s *Service) Rivals(ctx context.Context, eventID, playerID string) (*Board, error) {
	entries, err := s.lb.Around(ctx, eventID, playerID, 5)
	if err != nil {
		return nil, fmt.Errorf("leaderboard around: %w", err)
	}
	if entries == nil {
		entries = []cache.Entry{}
	}
	total, err := s.lb.Count(ctx, eventID)
	if err != nil {
		return nil, err
	}
	b := &Board{EventID: eventID, Total: total, Entries: entries}
	if me, err := s.me(ctx, eventID, playerID); err == nil {
		b.Me = me
	}
	return b, nil
}

// Me returns the caller's rank entry, or nil when unranked.
func (s *Service) Me(ctx context.Context, eventID, playerID string) (*cache.Entry, error) {
	return s.me(ctx, eventID, playerID)
}

func (s *Service) me(ctx context.Context, eventID, playerID string) (*cache.Entry, error) {
	rank, score, found, err := s.lb.Rank(ctx, eventID, playerID)
	if err != nil || !found {
		return nil, err
	}
	return &cache.Entry{Rank: rank, PlayerID: playerID, Score: score}, nil
}

// Top returns the raw top N (used by the reward distributor).
func (s *Service) Top(ctx context.Context, eventID string, n int) ([]cache.Entry, error) {
	return s.lb.Top(ctx, eventID, n)
}

// Sink applies RunFinished events to the sorted set. It is idempotent (ZADD GT
// keeps the max), so redelivery from SQS is harmless.
type Sink struct {
	lb cache.Leaderboard
}

// NewSink creates the telemetry sink.
func NewSink(lb cache.Leaderboard) *Sink { return &Sink{lb: lb} }

func (s *Sink) Name() string { return "leaderboard" }

func (s *Sink) Handle(ctx context.Context, ev telemetry.Event) error {
	if ev.Type != telemetry.RunFinished || ev.EventID == "" || ev.PlayerID == "" {
		return nil
	}
	return s.lb.Submit(ctx, ev.EventID, ev.PlayerID, ev.Name, ev.Score)
}
