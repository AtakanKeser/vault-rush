// Package config loads runtime configuration from the environment.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the process configuration shared by api and worker.
type Config struct {
	Port        int
	Env         string
	Storage     string // memory | dynamodb
	Cache       string // memory | redis
	Queue       string // inline | sqs
	RedisAddr   string
	RedisPass   string
	DynamoURL   string
	DynamoTable string
	AWSRegion   string
	SQSQueueURL string
	SQSEndpoint string
	AdminToken  string
	TokenSecret string
	TokenTTL    time.Duration

	TelemetryWorkers int
	TelemetryBuffer  int
	RateLimitPerMin  int
	CORSOrigins      []string
	LogLevel         string
	EventSeedSalt    string
	RunTTL           time.Duration
	IdempotencyTTL   time.Duration
	LifeRegen        time.Duration
	Version          string
}

// Load reads the environment. Defaults target zero-dependency local runs.
func Load() (Config, error) {
	c := Config{
		Port:             envInt("PORT", 8080),
		Env:              env("ENV", "local"),
		Storage:          env("STORAGE", "memory"),
		Cache:            env("CACHE", "memory"),
		Queue:            env("QUEUE", "inline"),
		RedisAddr:        env("REDIS_ADDR", "localhost:6379"),
		RedisPass:        env("REDIS_PASSWORD", ""),
		DynamoURL:        env("DYNAMODB_ENDPOINT", ""),
		DynamoTable:      env("DYNAMODB_TABLE", "vault_rush"),
		AWSRegion:        env("AWS_REGION", "eu-central-1"),
		SQSQueueURL:      env("SQS_QUEUE_URL", ""),
		SQSEndpoint:      env("SQS_ENDPOINT", ""),
		AdminToken:       env("ADMIN_TOKEN", "local-admin-token"),
		TokenSecret:      env("TOKEN_SECRET", "dev-secret-change-me"),
		TokenTTL:         envDuration("TOKEN_TTL", 0),
		TelemetryWorkers: envInt("TELEMETRY_WORKERS", 8),
		TelemetryBuffer:  envInt("TELEMETRY_BUFFER", 1000),
		RateLimitPerMin:  envInt("RATE_LIMIT_PER_MIN", 100),
		CORSOrigins:      splitCSV(env("CORS_ORIGINS", "*")),
		LogLevel:         env("LOG_LEVEL", "info"),
		EventSeedSalt:    env("EVENT_SEED_SALT", "vault-rush"),
		RunTTL:           envDuration("RUN_TTL", 2*time.Hour),
		IdempotencyTTL:   envDuration("IDEMPOTENCY_TTL", 24*time.Hour),
		LifeRegen:        envDuration("LIFE_REGEN", 30*time.Minute),
		Version:          env("APP_VERSION", "dev"),
	}
	switch c.Storage {
	case "memory", "dynamodb":
	default:
		return c, fmt.Errorf("STORAGE must be memory|dynamodb, got %q", c.Storage)
	}
	switch c.Cache {
	case "memory", "redis":
	default:
		return c, fmt.Errorf("CACHE must be memory|redis, got %q", c.Cache)
	}
	switch c.Queue {
	case "inline", "sqs":
	default:
		return c, fmt.Errorf("QUEUE must be inline|sqs, got %q", c.Queue)
	}
	if c.Queue == "sqs" && c.SQSQueueURL == "" {
		return c, fmt.Errorf("SQS_QUEUE_URL is required when QUEUE=sqs")
	}
	if c.Env == "production" {
		if c.AdminToken == "local-admin-token" || c.TokenSecret == "dev-secret-change-me" {
			return c, fmt.Errorf("ADMIN_TOKEN and TOKEN_SECRET must be set in production")
		}
	}
	return c, nil
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
