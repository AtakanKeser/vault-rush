// Package engine implements the deterministic Vault Rush puzzle engine.
//
// The engine is intentionally free of floating point in every code path that
// influences board state so that the TypeScript port (client/src/engine) can
// reproduce it bit-for-bit. See docs/engine.md for the normative description.
package engine

// RNG is a mulberry32 generator. It is tiny, fast, and trivially portable to
// JavaScript (Math.imul + >>> 0), which is why it was chosen over Go's
// math/rand sources.
type RNG struct {
	state uint32
}

// NewRNG seeds a generator. Only the low 32 bits of seed are used.
func NewRNG(seed uint32) *RNG {
	return &RNG{state: seed}
}

// Next returns the next 32-bit value.
func (r *RNG) Next() uint32 {
	r.state += 0x6D2B79F5
	t := r.state
	t = (t ^ (t >> 15)) * (1 | t)
	t = (t + ((t ^ (t >> 7)) * (61 | t))) ^ t
	return t ^ (t >> 14)
}

// NextInt returns a value in [0, n). n must be > 0.
func (r *RNG) NextInt(n int) int {
	if n <= 0 {
		panic("engine: NextInt with n <= 0")
	}
	return int(r.Next() % uint32(n))
}

// State exposes the internal state for snapshot/debug purposes.
func (r *RNG) State() uint32 { return r.state }
