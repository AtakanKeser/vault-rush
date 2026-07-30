// Package queue moves telemetry across process boundaries through SQS.
//
// In QUEUE=sqs mode the API process publishes every event to the queue (its
// only sink) and the worker process long-polls it, dispatching to the real
// sinks. Failed messages become visible again and land in the DLQ after
// maxReceiveCount attempts — at-least-once delivery, which every sink
// tolerates (ZADD GT, SADD, idempotent grants).
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"

	"github.com/atakank/vault-rush/backend/internal/telemetry"
)

// Options configure the SQS client.
type Options struct {
	QueueURL string
	Region   string
	Endpoint string // non-empty → ElasticMQ / LocalStack
}

// Client wraps the SQS API.
type Client struct {
	sqs      *sqs.Client
	queueURL string
}

// New creates a client.
func New(ctx context.Context, opts Options) (*Client, error) {
	loadOpts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(opts.Region)}
	if opts.Endpoint != "" {
		loadOpts = append(loadOpts, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("local", "local", "")))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	var clientOpts []func(*sqs.Options)
	if opts.Endpoint != "" {
		clientOpts = append(clientOpts, func(o *sqs.Options) { o.BaseEndpoint = aws.String(opts.Endpoint) })
	}
	return &Client{sqs: sqs.NewFromConfig(cfg, clientOpts...), queueURL: opts.QueueURL}, nil
}

// Ping checks the queue is reachable.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.sqs.GetQueueAttributes(ctx, &sqs.GetQueueAttributesInput{
		QueueUrl:       &c.queueURL,
		AttributeNames: []types.QueueAttributeName{types.QueueAttributeNameApproximateNumberOfMessages},
	})
	return err
}

// Depth returns the approximate number of visible messages.
func (c *Client) Depth(ctx context.Context) (int, error) {
	out, err := c.sqs.GetQueueAttributes(ctx, &sqs.GetQueueAttributesInput{
		QueueUrl:       &c.queueURL,
		AttributeNames: []types.QueueAttributeName{types.QueueAttributeNameApproximateNumberOfMessages},
	})
	if err != nil {
		return 0, err
	}
	n := 0
	fmt.Sscanf(out.Attributes[string(types.QueueAttributeNameApproximateNumberOfMessages)], "%d", &n)
	return n, nil
}

// Publisher is a telemetry.Sink that forwards events to SQS.
type Publisher struct {
	c *Client
}

// NewPublisher creates the sink.
func NewPublisher(c *Client) *Publisher { return &Publisher{c: c} }

func (p *Publisher) Name() string { return "sqs" }

func (p *Publisher) Handle(ctx context.Context, ev telemetry.Event) error {
	body, err := json.Marshal(ev)
	if err != nil {
		return telemetry.Permanent{Err: err}
	}
	_, err = p.c.sqs.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    &p.c.queueURL,
		MessageBody: aws.String(string(body)),
		MessageAttributes: map[string]types.MessageAttributeValue{
			"type": {DataType: aws.String("String"), StringValue: aws.String(ev.Type)},
		},
	})
	return err
}

// Consumer long-polls the queue and dispatches to a bus synchronously.
type Consumer struct {
	c           *Client
	bus         *telemetry.Bus
	log         *slog.Logger
	concurrency int
	processed   int64
	failed      int64
	mu          sync.Mutex
}

// NewConsumer creates a consumer with n parallel pollers.
func NewConsumer(c *Client, bus *telemetry.Bus, concurrency int, log *slog.Logger) *Consumer {
	if concurrency <= 0 {
		concurrency = 2
	}
	if log == nil {
		log = slog.Default()
	}
	return &Consumer{c: c, bus: bus, log: log, concurrency: concurrency}
}

// Stats returns processed/failed counters.
func (k *Consumer) Stats() (processed, failed int64) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.processed, k.failed
}

// Run blocks until ctx is cancelled and all pollers have exited.
func (k *Consumer) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for i := 0; i < k.concurrency; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			k.poll(ctx, id)
		}(i)
	}
	wg.Wait()
}

func (k *Consumer) poll(ctx context.Context, id int) {
	for ctx.Err() == nil {
		out, err := k.c.sqs.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl:              &k.c.queueURL,
			MaxNumberOfMessages:   10,
			WaitTimeSeconds:       20,
			VisibilityTimeout:     30,
			MessageAttributeNames: []string{"All"},
		})
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			k.log.Warn("sqs receive failed, backing off", "poller", id, "err", err)
			select {
			case <-time.After(2 * time.Second):
			case <-ctx.Done():
				return
			}
			continue
		}
		for _, m := range out.Messages {
			k.handle(ctx, m)
		}
	}
}

func (k *Consumer) handle(ctx context.Context, m types.Message) {
	var ev telemetry.Event
	if err := json.Unmarshal([]byte(aws.ToString(m.Body)), &ev); err != nil {
		k.log.Error("sqs message is not a telemetry event; deleting", "err", err)
		k.delete(ctx, m)
		return
	}
	// Give the sinks a bounded window smaller than the visibility timeout.
	hctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	err := k.bus.Dispatch(hctx, ev)
	cancel()
	k.mu.Lock()
	if err != nil {
		k.failed++
	} else {
		k.processed++
	}
	k.mu.Unlock()
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return // shutting down: leave the message for the next worker
		}
		k.log.Warn("event dispatch failed; message will be redelivered", "type", ev.Type, "id", ev.ID, "err", err)
		return
	}
	k.delete(ctx, m)
}

func (k *Consumer) delete(ctx context.Context, m types.Message) {
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, err := k.c.sqs.DeleteMessage(dctx, &sqs.DeleteMessageInput{QueueUrl: &k.c.queueURL, ReceiptHandle: m.ReceiptHandle}); err != nil {
		k.log.Warn("sqs delete failed", "err", err)
	}
}
