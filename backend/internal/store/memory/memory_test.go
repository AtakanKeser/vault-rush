package memory

import (
	"testing"

	"github.com/atakank/vault-rush/backend/internal/store/storetest"
)

func TestConformance(t *testing.T) {
	storetest.Run(t, New())
}
