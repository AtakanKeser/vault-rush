// Package telemetry is the asynchronous event pipeline.
//
// The request path does exactly one cheap thing — a non-blocking send on a
// buffered channel — and returns to the player. A pool of goroutines drains
// the channel and fans every event out to sinks (analytics counters,
// leaderboard, SQS publisher). Sinks are retried with exponential backoff and
// the bus drains completely on shutdown so a deploy never loses events that
// were already accepted.
package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// Event types emitted by the gameplay services.
const (
	RunStarted    = "RunStarted"
	RunFinished   = "RunFinished"
	VaultReached  = "VaultReached"
	BoosterUsed   = "BoosterUsed"
	RewardClaimed = "RewardClaimed"
	PlayerCreated = "PlayerCreated"
	Purchase      = "Purchase"
)

// Event is the wire format shared by the in-process bus and SQS.
type Event struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	PlayerID  string    `json:"playerId,omitempty"`
	Group     string    `json:"group,omitempty"`
	EventID   string    `json:"eventId,omitempty"`
	RunID     string    `json:"runId,omitempty"`
	Vault     int       `json:"vault,omitempty"`
	Score     int64     `json:"score,omitempty"`
	Loot      int64     `json:"loot,omitempty"`
	Outcome   string    `json:"outcome,omitempty"`
	Booster   string    `json:"booster,omitempty"`
	Item      string    `json:"item,omitempty"`
	Coins     int64     `json:"coins,omitempty"`
	Name      string    `json:"name,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

// Sink consumes events. Implementations must be safe for concurrent use.
type Sink interface {
	Name() string
	Handle(ctx context.Context, ev Event) error
}

// Permanent marks an error that must not be retried.
type Permanent struct{ Err error }

func (p Permanent) Error() string { return p.Err.Error() }
func (p Permanent) Unwrap() error { return p.Err }

// Stats is a snapshot of pipeline health exposed on /metrics and the admin API.
type Stats struct {
	QueueDepth int   `json:"queueDepth"`
	Capacity   int   `json:"capacity"`
	Workers    int   `json:"workers"`
	Published  int64 `json:"published"`
	Processed  int64 `json:"processed"`
	Dropped    int64 `json:"dropped"`
	Retries    int64 `json:"retries"`
	Failed     int64 `json:"failed"`
}

// Bus is the channel-backed fan-out pipeline.
type Bus struct {
	ch       chan Event
	sinks    []Sink
	workers  int
	log      *slog.Logger
	wg       sync.WaitGroup
	once     sync.Once
	closed   atomic.Bool
	backoff  time.Duration
	attempts int

	published atomic.Int64
	processed atomic.Int64
	dropped   atomic.Int64
	retries   atomic.Int64
	failed    atomic.Int64
}

// Option configures a Bus.
type Option func(*Bus)

// WithBackoff sets the base backoff and max attempts per sink.
func WithBackoff(base time.Duration, attempts int) Option {
	return func(b *Bus) { b.backoff = base; b.attempts = attempts }
}

// NewBus creates a bus. Call Start before publishing.
func NewBus(buffer, workers int, sinks []Sink, log *slog.Logger, opts ...Option) *Bus {
	if buffer <= 0 {
		buffer = 1000
	}
	if workers <= 0 {
		workers = 4
	}
	if log == nil {
		log = slog.Default()
	}
	b := &Bus{ch: make(chan Event, buffer), sinks: sinks, workers: workers, log: log, backoff: 50 * time.Millisecond, attempts: 5}
	for _, o := range opts {
		o(b)
	}
	return b
}

// Start launches the worker pool. ctx cancels in-flight sink calls only; use
// Shutdown to drain gracefully.
func (b *Bus) Start(ctx context.Context) {
	for i := 0; i < b.workers; i++ {
		b.wg.Add(1)
		go b.worker(ctx, i)
	}
}

func (b *Bus) worker(ctx context.Context, id int) {
	defer b.wg.Done()
	for ev := range b.ch {
		b.dispatch(ctx, ev)
		b.processed.Add(1)
	}
	b.log.Debug("telemetry worker drained", "worker", id)
}

func (b *Bus) dispatch(ctx context.Context, ev Event) {
	for _, s := range b.sinks {
		if err := b.deliver(ctx, s, ev); err != nil {
			b.failed.Add(1)
			b.log.Error("telemetry sink failed permanently", "sink", s.Name(), "type", ev.Type, "id", ev.ID, "err", err)
		}
	}
}

func (b *Bus) deliver(ctx context.Context, s Sink, ev Event) error {
	var last error
	for attempt := 0; attempt < b.attempts; attempt++ {
		if attempt > 0 {
			b.retries.Add(1)
			delay := b.backoff << (attempt - 1)
			if delay > 5*time.Second {
				delay = 5 * time.Second
			}
			timer := time.NewTimer(delay)
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			}
		}
		err := s.Handle(ctx, ev)
		if err == nil {
			return nil
		}
		var perm Permanent
		if errors.As(err, &perm) {
			return err
		}
		last = err
		b.log.Warn("telemetry sink error, will retry", "sink", s.Name(), "type", ev.Type, "attempt", attempt+1, "err", err)
	}
	return last
}

// Publish enqueues without blocking the caller. When the buffer is full the
// event is dropped and counted — latency of the gameplay path matters more
// than a single analytics point.
func (b *Bus) Publish(ev Event) bool {
	if b.closed.Load() {
		b.dropped.Add(1)
		return false
	}
	if ev.Timestamp.IsZero() {
		ev.Timestamp = time.Now().UTC()
	}
	select {
	case b.ch <- ev:
		b.published.Add(1)
		return true
	default:
		b.dropped.Add(1)
		b.log.Warn("telemetry buffer full, dropping event", "type", ev.Type)
		return false
	}
}

// Shutdown stops accepting events and waits for the workers to drain the
// channel, or until ctx expires.
func (b *Bus) Shutdown(ctx context.Context) error {
	b.once.Do(func() {
		b.closed.Store(true)
		close(b.ch)
	})
	done := make(chan struct{})
	go func() {
		b.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Stats returns a snapshot.
func (b *Bus) Stats() Stats {
	return Stats{
		QueueDepth: len(b.ch),
		Capacity:   cap(b.ch),
		Workers:    b.workers,
		Published:  b.published.Load(),
		Processed:  b.processed.Load(),
		Dropped:    b.dropped.Load(),
		Retries:    b.retries.Load(),
		Failed:     b.failed.Load(),
	}
}

// Dispatch delivers one event synchronously through the sinks with the same
// retry policy. Used by the SQS worker where the queue itself is the buffer.
func (b *Bus) Dispatch(ctx context.Context, ev Event) error {
	var errs []error
	for _, s := range b.sinks {
		if err := b.deliver(ctx, s, ev); err != nil {
			errs = append(errs, err)
		}
	}
	b.processed.Add(1)
	return errors.Join(errs...)
}

// FuncSink adapts a function to Sink.
type FuncSink struct {
	SinkName string
	Fn       func(ctx context.Context, ev Event) error
}

func (f FuncSink) Name() string                               { return f.SinkName }
func (f FuncSink) Handle(ctx context.Context, ev Event) error { return f.Fn(ctx, ev) }
