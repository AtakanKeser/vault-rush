// Package dynamo implements store.Store on a single DynamoDB table.
//
// Key design (PK / SK):
//
//	PLAYER#<id>            PROFILE              player (version attribute drives OCC)
//	DEVICE#<deviceId>      PLAYER               device → player pointer (uniqueness)
//	PLAYER#<id>            RUN#<runId>          run (status attribute drives the finish condition)
//	PLAYER#<id>            REWARD#<rewardId>    reward (status attribute drives exactly-once claim)
//	EVENT#<id>             META                 event header; GSI1PK=EVENT, GSI1SK=<startsAt RFC3339>
//	EVENT#<id>             CONFIG#<00017>       immutable config version
//	IDEMP#<player>#<key>   RESPONSE             idempotency record with TTL
//
// Entities are stored as a JSON blob in `data` plus the few attributes that
// conditions and projections need. This keeps the adapter small and the
// domain model the single source of truth for shapes.
package dynamo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/store"
	"github.com/atakank/vault-rush/backend/pkg/engine"
)

// Options configure the client.
type Options struct {
	Table    string
	Region   string
	Endpoint string // non-empty → DynamoDB Local
}

// Store is the DynamoDB adapter.
type Store struct {
	db    *dynamodb.Client
	table string
}

// New creates the adapter and verifies the table exists.
func New(ctx context.Context, opts Options) (*Store, error) {
	loadOpts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(opts.Region)}
	if opts.Endpoint != "" {
		loadOpts = append(loadOpts, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("local", "local", "")))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	var clientOpts []func(*dynamodb.Options)
	if opts.Endpoint != "" {
		clientOpts = append(clientOpts, func(o *dynamodb.Options) { o.BaseEndpoint = aws.String(opts.Endpoint) })
	}
	s := &Store{db: dynamodb.NewFromConfig(cfg, clientOpts...), table: opts.Table}
	return s, nil
}

// EnsureTable creates the table when it is missing (local/dev only; Terraform
// owns the production table).
func (s *Store) EnsureTable(ctx context.Context) error {
	_, err := s.db.DescribeTable(ctx, &dynamodb.DescribeTableInput{TableName: &s.table})
	if err == nil {
		return nil
	}
	var nf *types.ResourceNotFoundException
	if !errors.As(err, &nf) {
		return err
	}
	_, err = s.db.CreateTable(ctx, &dynamodb.CreateTableInput{
		TableName:   &s.table,
		BillingMode: types.BillingModePayPerRequest,
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("PK"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("SK"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("GSI1PK"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("GSI1SK"), AttributeType: types.ScalarAttributeTypeS},
		},
		KeySchema: []types.KeySchemaElement{
			{AttributeName: aws.String("PK"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("SK"), KeyType: types.KeyTypeRange},
		},
		GlobalSecondaryIndexes: []types.GlobalSecondaryIndex{{
			IndexName: aws.String("GSI1"),
			KeySchema: []types.KeySchemaElement{
				{AttributeName: aws.String("GSI1PK"), KeyType: types.KeyTypeHash},
				{AttributeName: aws.String("GSI1SK"), KeyType: types.KeyTypeRange},
			},
			Projection: &types.Projection{ProjectionType: types.ProjectionTypeAll},
		}},
	})
	if err != nil {
		// api and worker may race to create the table on a fresh local stack.
		var inUse *types.ResourceInUseException
		if !errors.As(err, &inUse) {
			return err
		}
	}
	waiter := dynamodb.NewTableExistsWaiter(s.db)
	if err := waiter.Wait(ctx, &dynamodb.DescribeTableInput{TableName: &s.table}, 30*time.Second); err != nil {
		return err
	}
	_, _ = s.db.UpdateTimeToLive(ctx, &dynamodb.UpdateTimeToLiveInput{
		TableName:               &s.table,
		TimeToLiveSpecification: &types.TimeToLiveSpecification{AttributeName: aws.String("ttl"), Enabled: aws.Bool(true)},
	})
	return nil
}

func (s *Store) Players() store.Players         { return (*players)(s) }
func (s *Store) Runs() store.Runs               { return (*runs)(s) }
func (s *Store) Events() store.Events           { return (*events)(s) }
func (s *Store) Rewards() store.Rewards         { return (*rewards)(s) }
func (s *Store) Idempotency() store.Idempotency { return (*idem)(s) }
func (s *Store) Name() string                   { return "dynamodb" }
func (s *Store) Close() error                   { return nil }

// Ping verifies connectivity with a cheap DescribeTable.
func (s *Store) Ping(ctx context.Context) error {
	_, err := s.db.DescribeTable(ctx, &dynamodb.DescribeTableInput{TableName: &s.table})
	return err
}

// item is the generic row shape.
type item struct {
	PK      string `dynamodbav:"PK"`
	SK      string `dynamodbav:"SK"`
	GSI1PK  string `dynamodbav:"GSI1PK,omitempty"`
	GSI1SK  string `dynamodbav:"GSI1SK,omitempty"`
	Type    string `dynamodbav:"type"`
	Version int    `dynamodbav:"version,omitempty"`
	Status  string `dynamodbav:"status,omitempty"`
	Data    []byte `dynamodbav:"data,omitempty"`
	TTL     int64  `dynamodbav:"ttl,omitempty"`
	// Config projections for cheap version listings.
	CreatedAt string `dynamodbav:"createdAt,omitempty"`
	CreatedBy string `dynamodbav:"createdBy,omitempty"`
	Note      string `dynamodbav:"note,omitempty"`
	// Pointers.
	PlayerID string `dynamodbav:"playerId,omitempty"`
}

func key(pk, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{"PK": &types.AttributeValueMemberS{Value: pk}, "SK": &types.AttributeValueMemberS{Value: sk}}
}

func isConditionFailed(err error) bool {
	var ccf *types.ConditionalCheckFailedException
	if errors.As(err, &ccf) {
		return true
	}
	var tx *types.TransactionCanceledException
	if errors.As(err, &tx) {
		for _, r := range tx.CancellationReasons {
			if r.Code != nil && *r.Code == "ConditionalCheckFailed" {
				return true
			}
		}
	}
	return false
}

func (s *Store) get(ctx context.Context, pk, sk string, out any) error {
	res, err := s.db.GetItem(ctx, &dynamodb.GetItemInput{TableName: &s.table, Key: key(pk, sk), ConsistentRead: aws.Bool(true)})
	if err != nil {
		return err
	}
	if res.Item == nil {
		return domain.ErrNotFound
	}
	var it item
	if err := attributevalue.UnmarshalMap(res.Item, &it); err != nil {
		return err
	}
	return json.Unmarshal(it.Data, out)
}

func (s *Store) put(ctx context.Context, it item, condition *string) error {
	av, err := attributevalue.MarshalMap(it)
	if err != nil {
		return err
	}
	_, err = s.db.PutItem(ctx, &dynamodb.PutItemInput{TableName: &s.table, Item: av, ConditionExpression: condition})
	if err != nil && isConditionFailed(err) {
		return domain.ErrAlreadyExists
	}
	return err
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// ---- players ----

type players Store

func playerPK(id string) string { return "PLAYER#" + id }

func (p *players) Create(ctx context.Context, pl *domain.Player) error {
	profile, err := attributevalue.MarshalMap(item{PK: playerPK(pl.ID), SK: "PROFILE", Type: "player", Version: pl.Version, Data: mustJSON(pl)})
	if err != nil {
		return err
	}
	tx := []types.TransactWriteItem{{Put: &types.Put{TableName: &p.table, Item: profile, ConditionExpression: aws.String("attribute_not_exists(PK)")}}}
	if pl.DeviceID != "" {
		dev, err := attributevalue.MarshalMap(item{PK: "DEVICE#" + pl.DeviceID, SK: "PLAYER", Type: "device", PlayerID: pl.ID})
		if err != nil {
			return err
		}
		tx = append(tx, types.TransactWriteItem{Put: &types.Put{TableName: &p.table, Item: dev, ConditionExpression: aws.String("attribute_not_exists(PK)")}})
	}
	_, err = p.db.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: tx})
	if err != nil && isConditionFailed(err) {
		return domain.ErrAlreadyExists
	}
	return err
}

func (p *players) Get(ctx context.Context, id string) (*domain.Player, error) {
	var pl domain.Player
	if err := (*Store)(p).get(ctx, playerPK(id), "PROFILE", &pl); err != nil {
		return nil, err
	}
	return &pl, nil
}

func (p *players) GetByDevice(ctx context.Context, deviceID string) (*domain.Player, error) {
	res, err := p.db.GetItem(ctx, &dynamodb.GetItemInput{TableName: &p.table, Key: key("DEVICE#"+deviceID, "PLAYER"), ConsistentRead: aws.Bool(true)})
	if err != nil {
		return nil, err
	}
	if res.Item == nil {
		return nil, domain.ErrNotFound
	}
	var it item
	if err := attributevalue.UnmarshalMap(res.Item, &it); err != nil {
		return nil, err
	}
	return p.Get(ctx, it.PlayerID)
}

func (p *players) Update(ctx context.Context, pl *domain.Player) error {
	expected := pl.Version
	pl.Version++
	pl.UpdatedAt = time.Now().UTC()
	_, err := p.db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                &p.table,
		Key:                      key(playerPK(pl.ID), "PROFILE"),
		UpdateExpression:         aws.String("SET #d = :d, version = :v"),
		ConditionExpression:      aws.String("attribute_exists(PK) AND version = :expected"),
		ExpressionAttributeNames: map[string]string{"#d": "data"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":d":        &types.AttributeValueMemberB{Value: mustJSON(pl)},
			":v":        &types.AttributeValueMemberN{Value: fmt.Sprint(pl.Version)},
			":expected": &types.AttributeValueMemberN{Value: fmt.Sprint(expected)},
		},
	})
	if err != nil {
		pl.Version = expected
		if isConditionFailed(err) {
			// Distinguish missing from stale: a cheap follow-up read.
			if _, gerr := p.Get(ctx, pl.ID); errors.Is(gerr, domain.ErrNotFound) {
				return domain.ErrNotFound
			}
			return domain.ErrVersionConflict
		}
		return err
	}
	return nil
}

// ---- runs ----

type runs Store

func (r *runs) Put(ctx context.Context, run *domain.Run) error {
	return (*Store)(r).put(ctx, item{PK: playerPK(run.PlayerID), SK: "RUN#" + run.ID, Type: "run", Status: string(run.Status), Data: mustJSON(run)}, nil)
}

func (r *runs) Get(ctx context.Context, playerID, runID string) (*domain.Run, error) {
	var run domain.Run
	if err := (*Store)(r).get(ctx, playerPK(playerID), "RUN#"+runID, &run); err != nil {
		return nil, err
	}
	return &run, nil
}

func (r *runs) Finish(ctx context.Context, run *domain.Run) error {
	run.Status = domain.RunFinished
	_, err := r.db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                &r.table,
		Key:                      key(playerPK(run.PlayerID), "RUN#"+run.ID),
		UpdateExpression:         aws.String("SET #d = :d, #s = :finished"),
		ConditionExpression:      aws.String("attribute_exists(PK) AND #s = :active"),
		ExpressionAttributeNames: map[string]string{"#d": "data", "#s": "status"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":d":        &types.AttributeValueMemberB{Value: mustJSON(run)},
			":finished": &types.AttributeValueMemberS{Value: string(domain.RunFinished)},
			":active":   &types.AttributeValueMemberS{Value: string(domain.RunActive)},
		},
	})
	if err != nil {
		run.Status = domain.RunActive
		if isConditionFailed(err) {
			if _, gerr := r.Get(ctx, run.PlayerID, run.ID); errors.Is(gerr, domain.ErrNotFound) {
				return domain.ErrNotFound
			}
			return domain.ErrConflict
		}
		return err
	}
	return nil
}

func (r *runs) ListByPlayer(ctx context.Context, playerID string, limit int) ([]*domain.Run, error) {
	if limit <= 0 {
		limit = 20
	}
	res, err := r.db.Query(ctx, &dynamodb.QueryInput{
		TableName:              &r.table,
		KeyConditionExpression: aws.String("PK = :pk AND begins_with(SK, :sk)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk": &types.AttributeValueMemberS{Value: playerPK(playerID)},
			":sk": &types.AttributeValueMemberS{Value: "RUN#"},
		},
		ScanIndexForward: aws.Bool(false),
		Limit:            aws.Int32(int32(limit)),
	})
	if err != nil {
		return nil, err
	}
	out := make([]*domain.Run, 0, len(res.Items))
	for _, raw := range res.Items {
		var it item
		if err := attributevalue.UnmarshalMap(raw, &it); err != nil {
			return nil, err
		}
		var run domain.Run
		if err := json.Unmarshal(it.Data, &run); err != nil {
			return nil, err
		}
		out = append(out, &run)
	}
	return out, nil
}

// ---- events ----

type events Store

func eventPK(id string) string    { return "EVENT#" + id }
func configSK(version int) string { return fmt.Sprintf("CONFIG#%05d", version) }
func rfc3339(t time.Time) string  { return t.UTC().Format(time.RFC3339) }

func (e *events) metaItem(m *domain.EventMeta) item {
	return item{PK: eventPK(m.ID), SK: "META", GSI1PK: "EVENT", GSI1SK: rfc3339(m.StartsAt), Type: "event", Version: m.ConfigVersion, Data: mustJSON(m)}
}

func (e *events) CreateMeta(ctx context.Context, m *domain.EventMeta) error {
	return (*Store)(e).put(ctx, e.metaItem(m), aws.String("attribute_not_exists(PK)"))
}

func (e *events) UpdateMeta(ctx context.Context, m *domain.EventMeta) error {
	err := (*Store)(e).put(ctx, e.metaItem(m), aws.String("attribute_exists(PK)"))
	if errors.Is(err, domain.ErrAlreadyExists) {
		return domain.ErrNotFound
	}
	return err
}

func (e *events) GetMeta(ctx context.Context, id string) (*domain.EventMeta, error) {
	var m domain.EventMeta
	if err := (*Store)(e).get(ctx, eventPK(id), "META", &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func (e *events) ListMeta(ctx context.Context, from, to time.Time) ([]*domain.EventMeta, error) {
	// Events are at most a few days long; widen the start window so events that
	// started before `from` but are still running are included, then filter.
	res, err := e.db.Query(ctx, &dynamodb.QueryInput{
		TableName:              &e.table,
		IndexName:              aws.String("GSI1"),
		KeyConditionExpression: aws.String("GSI1PK = :pk AND GSI1SK BETWEEN :from AND :to"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":   &types.AttributeValueMemberS{Value: "EVENT"},
			":from": &types.AttributeValueMemberS{Value: rfc3339(from.Add(-7 * 24 * time.Hour))},
			":to":   &types.AttributeValueMemberS{Value: rfc3339(to)},
		},
	})
	if err != nil {
		return nil, err
	}
	var out []*domain.EventMeta
	for _, raw := range res.Items {
		var it item
		if err := attributevalue.UnmarshalMap(raw, &it); err != nil {
			return nil, err
		}
		var m domain.EventMeta
		if err := json.Unmarshal(it.Data, &m); err != nil {
			return nil, err
		}
		if m.EndsAt.After(from) && m.StartsAt.Before(to) {
			out = append(out, &m)
		}
	}
	return out, nil
}

func (e *events) PutConfig(ctx context.Context, cfg *engine.Config) error {
	return (*Store)(e).put(ctx, item{
		PK: eventPK(cfg.EventID), SK: configSK(cfg.Version), Type: "config", Version: cfg.Version,
		CreatedAt: rfc3339(cfg.CreatedAt), CreatedBy: cfg.CreatedBy, Note: cfg.Note, Data: mustJSON(cfg),
	}, aws.String("attribute_not_exists(PK)"))
}

func (e *events) GetConfig(ctx context.Context, eventID string, version int) (*engine.Config, error) {
	var cfg engine.Config
	if err := (*Store)(e).get(ctx, eventPK(eventID), configSK(version), &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (e *events) ListConfigVersions(ctx context.Context, eventID string) ([]domain.ConfigVersionInfo, error) {
	res, err := e.db.Query(ctx, &dynamodb.QueryInput{
		TableName:              &e.table,
		KeyConditionExpression: aws.String("PK = :pk AND begins_with(SK, :sk)"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk": &types.AttributeValueMemberS{Value: eventPK(eventID)},
			":sk": &types.AttributeValueMemberS{Value: "CONFIG#"},
		},
		ProjectionExpression: aws.String("version, createdAt, createdBy, note"),
		ScanIndexForward:     aws.Bool(false),
	})
	if err != nil {
		return nil, err
	}
	out := make([]domain.ConfigVersionInfo, 0, len(res.Items))
	for _, raw := range res.Items {
		var it item
		if err := attributevalue.UnmarshalMap(raw, &it); err != nil {
			return nil, err
		}
		t, _ := time.Parse(time.RFC3339, it.CreatedAt)
		out = append(out, domain.ConfigVersionInfo{Version: it.Version, CreatedAt: t, CreatedBy: it.CreatedBy, Note: it.Note})
	}
	return out, nil
}

// ---- rewards ----

type rewards Store

func (r *rewards) Put(ctx context.Context, rw *domain.Reward) error {
	return (*Store)(r).put(ctx, item{PK: playerPK(rw.PlayerID), SK: "REWARD#" + rw.ID, Type: "reward", Status: string(rw.Status), Data: mustJSON(rw)}, nil)
}

func (r *rewards) Create(ctx context.Context, rw *domain.Reward) error {
	return (*Store)(r).put(ctx, item{PK: playerPK(rw.PlayerID), SK: "REWARD#" + rw.ID, Type: "reward", Status: string(rw.Status), Data: mustJSON(rw)}, aws.String("attribute_not_exists(PK)"))
}

func (r *rewards) Get(ctx context.Context, playerID, rewardID string) (*domain.Reward, error) {
	var rw domain.Reward
	if err := (*Store)(r).get(ctx, playerPK(playerID), "REWARD#"+rewardID, &rw); err != nil {
		return nil, err
	}
	return &rw, nil
}

func (r *rewards) Claim(ctx context.Context, playerID, rewardID string, at time.Time) (*domain.Reward, error) {
	rw, err := r.Get(ctx, playerID, rewardID)
	if err != nil {
		return nil, err
	}
	if rw.Status != domain.RewardPending {
		return nil, domain.ErrConflict
	}
	rw.Status = domain.RewardClaimed
	t := at
	rw.ClaimedAt = &t
	_, err = r.db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                &r.table,
		Key:                      key(playerPK(playerID), "REWARD#"+rewardID),
		UpdateExpression:         aws.String("SET #d = :d, #s = :claimed"),
		ConditionExpression:      aws.String("attribute_exists(PK) AND #s = :pending"),
		ExpressionAttributeNames: map[string]string{"#d": "data", "#s": "status"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":d":       &types.AttributeValueMemberB{Value: mustJSON(rw)},
			":claimed": &types.AttributeValueMemberS{Value: string(domain.RewardClaimed)},
			":pending": &types.AttributeValueMemberS{Value: string(domain.RewardPending)},
		},
	})
	if err != nil {
		if isConditionFailed(err) {
			return nil, domain.ErrConflict
		}
		return nil, err
	}
	return rw, nil
}

func (r *rewards) ListPending(ctx context.Context, playerID string) ([]*domain.Reward, error) {
	res, err := r.db.Query(ctx, &dynamodb.QueryInput{
		TableName:                &r.table,
		KeyConditionExpression:   aws.String("PK = :pk AND begins_with(SK, :sk)"),
		FilterExpression:         aws.String("#s = :pending"),
		ExpressionAttributeNames: map[string]string{"#s": "status"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":      &types.AttributeValueMemberS{Value: playerPK(playerID)},
			":sk":      &types.AttributeValueMemberS{Value: "REWARD#"},
			":pending": &types.AttributeValueMemberS{Value: string(domain.RewardPending)},
		},
		ScanIndexForward: aws.Bool(false),
	})
	if err != nil {
		return nil, err
	}
	out := make([]*domain.Reward, 0, len(res.Items))
	for _, raw := range res.Items {
		var it item
		if err := attributevalue.UnmarshalMap(raw, &it); err != nil {
			return nil, err
		}
		var rw domain.Reward
		if err := json.Unmarshal(it.Data, &rw); err != nil {
			return nil, err
		}
		out = append(out, &rw)
	}
	return out, nil
}

// ---- idempotency ----

type idem Store

func idemPK(playerID, k string) string { return "IDEMP#" + playerID + "#" + k }

func (i *idem) Begin(ctx context.Context, playerID, k string, ttl time.Duration) (*domain.IdempotencyRecord, bool, error) {
	now := time.Now().UTC()
	rec := &domain.IdempotencyRecord{PlayerID: playerID, Key: k, State: domain.IdempotencyInProgress, CreatedAt: now, ExpiresAt: now.Add(ttl)}
	return i.beginWithNames(ctx, playerID, k, rec)
}

func (i *idem) beginWithNames(ctx context.Context, playerID, k string, rec *domain.IdempotencyRecord) (*domain.IdempotencyRecord, bool, error) {
	av, err := attributevalue.MarshalMap(item{PK: idemPK(playerID, k), SK: "RESPONSE", Type: "idempotency", Status: string(rec.State), TTL: rec.ExpiresAt.Unix(), Data: mustJSON(rec)})
	if err != nil {
		return nil, false, err
	}
	_, err = i.db.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:                 &i.table,
		Item:                      av,
		ConditionExpression:       aws.String("attribute_not_exists(PK) OR #ttl < :now"),
		ExpressionAttributeNames:  map[string]string{"#ttl": "ttl"},
		ExpressionAttributeValues: map[string]types.AttributeValue{":now": &types.AttributeValueMemberN{Value: fmt.Sprint(time.Now().Unix())}},
	})
	if err == nil {
		return rec, true, nil
	}
	if !isConditionFailed(err) {
		return nil, false, err
	}
	var existing domain.IdempotencyRecord
	if gerr := (*Store)(i).get(ctx, idemPK(playerID, k), "RESPONSE", &existing); gerr != nil {
		return nil, false, gerr
	}
	return &existing, false, nil
}

func (i *idem) Complete(ctx context.Context, playerID, k string, status int, body []byte) error {
	// One conditional UpdateItem: no read-modify-write round-trip on the hot path.
	rec := domain.IdempotencyRecord{PlayerID: playerID, Key: k, State: domain.IdempotencyDone, StatusCode: status, Body: body, CreatedAt: time.Now().UTC()}
	_, err := i.db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                &i.table,
		Key:                      key(idemPK(playerID, k), "RESPONSE"),
		UpdateExpression:         aws.String("SET #d = :d, #s = :s"),
		ConditionExpression:      aws.String("attribute_exists(PK)"),
		ExpressionAttributeNames: map[string]string{"#d": "data", "#s": "status"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":d": &types.AttributeValueMemberB{Value: mustJSON(rec)},
			":s": &types.AttributeValueMemberS{Value: string(domain.IdempotencyDone)},
		},
	})
	if err != nil && isConditionFailed(err) {
		return domain.ErrNotFound
	}
	return err
}

func (i *idem) Abort(ctx context.Context, playerID, k string) error {
	_, err := i.db.DeleteItem(ctx, &dynamodb.DeleteItemInput{TableName: &i.table, Key: key(idemPK(playerID, k), "RESPONSE")})
	return err
}
