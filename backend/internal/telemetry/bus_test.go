package telemetry

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type countingSink struct {
	name  string
	seen  atomic.Int64
	fails atomic.Int64 // number of times to fail before succeeding
	perm  bool
	mu    sync.Mutex
	ids   map[string]int
}

func (c *countingSink) Name() string { return c.name }
func (c *countingSink) Handle(_ context.Context, ev Event) error {
	if c.fails.Load() > 0 {
		c.fails.Add(-1)
		if c.perm {
			return Permanent{Err: errors.New("bad event")}
		}
		return errors.New("transient")
	}
	c.seen.Add(1)
	c.mu.Lock()
	if c.ids == nil {
		c.ids = map[string]int{}
	}
	c.ids[ev.ID]++
	c.mu.Unlock()
	return nil
}

func TestBusDeliversEveryEventToEverySink(t *testing.T) {
	a, b := &countingSink{name: "a"}, &countingSink{name: "b"}
	bus := NewBus(1000, 4, []Sink{a, b}, nil)
	bus.Start(context.Background())
	const n = 500
	for i := 0; i < n; i++ {
		if !bus.Publish(Event{ID: "e" + itoa(i), Type: RunFinished}) {
			t.Fatal("publish should not drop with room in the buffer")
		}
	}
	if err := bus.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a.seen.Load() != n || b.seen.Load() != n {
		t.Fatalf("delivered a=%d b=%d, want %d", a.seen.Load(), b.seen.Load(), n)
	}
	for id, c := range a.ids {
		if c != 1 {
			t.Fatalf("event %s delivered %d times", id, c)
		}
	}
	st := bus.Stats()
	if st.Published != n || st.Processed != n || st.Dropped != 0 || st.Failed != 0 {
		t.Fatalf("stats: %+v", st)
	}
}

func TestBusRetriesTransientErrors(t *testing.T) {
	s := &countingSink{name: "flaky"}
	s.fails.Store(2)
	bus := NewBus(10, 1, []Sink{s}, nil, WithBackoff(time.Millisecond, 5))
	bus.Start(context.Background())
	bus.Publish(Event{ID: "x", Type: RunFinished})
	_ = bus.Shutdown(context.Background())
	if s.seen.Load() != 1 {
		t.Fatalf("event should be delivered after retries, seen=%d", s.seen.Load())
	}
	if st := bus.Stats(); st.Retries != 2 || st.Failed != 0 {
		t.Fatalf("stats: %+v", st)
	}
}

func TestBusDoesNotRetryPermanentErrors(t *testing.T) {
	s := &countingSink{name: "strict", perm: true}
	s.fails.Store(1)
	bus := NewBus(10, 1, []Sink{s}, nil, WithBackoff(time.Millisecond, 5))
	bus.Start(context.Background())
	bus.Publish(Event{ID: "x", Type: RunFinished})
	_ = bus.Shutdown(context.Background())
	if st := bus.Stats(); st.Retries != 0 || st.Failed != 1 {
		t.Fatalf("permanent error must fail fast: %+v", st)
	}
}

func TestBusDropsWhenFullInsteadOfBlocking(t *testing.T) {
	block := make(chan struct{})
	slow := FuncSink{SinkName: "slow", Fn: func(ctx context.Context, ev Event) error { <-block; return nil }}
	bus := NewBus(2, 1, []Sink{slow}, nil)
	bus.Start(context.Background())
	// 1 in flight + 2 buffered, the 4th must be dropped immediately.
	done := make(chan struct{})
	go func() {
		for i := 0; i < 4; i++ {
			bus.Publish(Event{ID: itoa(i)})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Publish blocked the caller")
	}
	time.Sleep(20 * time.Millisecond)
	if bus.Stats().Dropped < 1 {
		t.Fatalf("expected at least one drop, stats=%+v", bus.Stats())
	}
	close(block)
	_ = bus.Shutdown(context.Background())
}

func TestShutdownDrainsAndRejectsLatePublishes(t *testing.T) {
	s := &countingSink{name: "a"}
	bus := NewBus(100, 2, []Sink{s}, nil)
	bus.Start(context.Background())
	for i := 0; i < 50; i++ {
		bus.Publish(Event{ID: itoa(i)})
	}
	if err := bus.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.seen.Load() != 50 {
		t.Fatalf("drain incomplete: %d/50", s.seen.Load())
	}
	if bus.Publish(Event{ID: "late"}) {
		t.Fatal("publish after shutdown must be rejected")
	}
	// Second shutdown is a no-op, not a panic.
	if err := bus.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestShutdownHonoursDeadline(t *testing.T) {
	block := make(chan struct{})
	slow := FuncSink{SinkName: "slow", Fn: func(ctx context.Context, ev Event) error { <-block; return nil }}
	bus := NewBus(10, 1, []Sink{slow}, nil)
	bus.Start(context.Background())
	bus.Publish(Event{ID: "x"})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := bus.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", err)
	}
	close(block)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	s := ""
	for i > 0 {
		s = string(rune('0'+i%10)) + s
		i /= 10
	}
	return s
}
