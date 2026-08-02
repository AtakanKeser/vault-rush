//go:build integration

package dynamo

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/atakank/vault-rush/backend/internal/store/storetest"
)

// Runs against DynamoDB Local:
//
//	DYNAMODB_ENDPOINT=http://localhost:8000 go test -tags=integration ./internal/store/dynamo/
func TestConformanceDynamoDBLocal(t *testing.T) {
	endpoint := os.Getenv("DYNAMODB_ENDPOINT")
	if endpoint == "" {
		t.Skip("DYNAMODB_ENDPOINT not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	table := os.Getenv("DYNAMODB_TABLE")
	if table == "" {
		table = "vault_rush_test"
	}
	st, err := New(ctx, Options{Table: table, Region: "eu-central-1", Endpoint: endpoint})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.EnsureTable(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	storetest.Run(t, st)
}
