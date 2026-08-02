package memory

import (
	"testing"

	"github.com/atakank/vault-rush/backend/internal/cache/cachetest"
)

func TestConformance(t *testing.T) {
	cachetest.Run(t, New())
}
