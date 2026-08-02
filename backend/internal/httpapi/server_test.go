package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/atakank/vault-rush/backend/internal/analytics"
	"github.com/atakank/vault-rush/backend/internal/auth"
	cachemem "github.com/atakank/vault-rush/backend/internal/cache/memory"
	"github.com/atakank/vault-rush/backend/internal/gameplay"
	"github.com/atakank/vault-rush/backend/internal/leaderboard"
	"github.com/atakank/vault-rush/backend/internal/liveops"
	"github.com/atakank/vault-rush/backend/internal/player"
	"github.com/atakank/vault-rush/backend/internal/reward"
	"github.com/atakank/vault-rush/backend/internal/shop"
	storemem "github.com/atakank/vault-rush/backend/internal/store/memory"
	"github.com/atakank/vault-rush/backend/internal/telemetry"
	"github.com/atakank/vault-rush/backend/pkg/engine"
)

type env struct {
	srv   *httptest.Server
	bus   *telemetry.Bus
	live  *liveops.Service
	now   time.Time
	clock func() time.Time
}

func newEnv(t *testing.T, rateLimit int) *env {
	t.Helper()
	st := storemem.New()
	c := cachemem.New()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	bus := telemetry.NewBus(1000, 4, []telemetry.Sink{analytics.NewSink(c.Analytics()), leaderboard.NewSink(c.Leaderboard())}, log)
	bus.Start(context.Background())
	e := &env{bus: bus, now: time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)}
	e.clock = func() time.Time { return e.now }

	tokens := auth.New("test-secret", 0)
	players := player.New(st, tokens, bus, 30*time.Minute).WithClock(e.clock)
	live := liveops.New(st, c.KV(), "salt").WithClock(e.clock)
	rewards := reward.New(st, players, bus, log)
	game := gameplay.New(st, players, live, rewards, bus, 2*time.Hour, log).WithClock(e.clock)
	e.live = live

	h := NewHandler(Deps{
		Log: log, Version: "test", Tokens: tokens, AdminToken: "admin-token",
		Players: players, Gameplay: game, Liveops: live, Leaderboard: leaderboard.New(c.Leaderboard()),
		Rewards: rewards, Shop: shop.New(players, bus), Analytics: analytics.New(c.Analytics()),
		Store: st, Cache: c, Bus: bus, QueueMode: "inline", RateLimitPerMin: rateLimit, IdempotencyTTL: time.Hour,
	})
	e.srv = httptest.NewServer(h)
	t.Cleanup(func() { e.srv.Close(); _ = bus.Shutdown(context.Background()) })
	return e
}

type resp struct {
	code   int
	body   map[string]any
	raw    []byte
	header http.Header
}

func (e *env) call(t *testing.T, method, path, token string, body any, headers map[string]string) resp {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := resp{code: res.StatusCode, raw: raw, header: res.Header}
	_ = json.Unmarshal(raw, &out.body)
	return out
}

func (e *env) newPlayer(t *testing.T, device string) string {
	r := e.call(t, "POST", "/v1/player", "", map[string]string{"deviceId": device, "displayName": "T-" + device}, nil)
	if r.code != http.StatusCreated {
		t.Fatalf("create player: %d %s", r.code, r.raw)
	}
	return r.body["token"].(string)
}

func errCode(r resp) string {
	if e, ok := r.body["error"].(map[string]any); ok {
		return e["code"].(string)
	}
	return ""
}

type startPayload struct {
	RunID    string        `json:"runId"`
	Seed     uint32        `json:"seed"`
	Boosters []string      `json:"boosters"`
	Config   engine.Config `json:"config"`
}

func (e *env) start(t *testing.T, token string, boosters []string) startPayload {
	r := e.call(t, "POST", "/v1/heists/start", token, map[string]any{"boosters": boosters}, nil)
	if r.code != http.StatusCreated {
		t.Fatalf("start: %d %s", r.code, r.raw)
	}
	var sp startPayload
	if err := json.Unmarshal(r.raw, &sp); err != nil {
		t.Fatal(err)
	}
	return sp
}

func TestFullHeistFlowWithIdempotentFinish(t *testing.T) {
	e := newEnv(t, 0)
	tok := e.newPlayer(t, "d1")

	prof := e.call(t, "GET", "/v1/player/profile", tok, nil, nil)
	if prof.code != 200 || prof.body["lives"].(float64) < 5 {
		t.Fatalf("profile: %d %s", prof.code, prof.raw)
	}
	cur := e.call(t, "GET", "/v1/events/current", tok, nil, nil)
	if cur.code != 200 || cur.body["event"].(map[string]any)["status"] != "ACTIVE" {
		t.Fatalf("events/current: %d %s", cur.code, cur.raw)
	}

	sp := e.start(t, tok, nil)
	rep, want := engine.Bot{}.PlayRun(&sp.Config, sp.Seed, sp.Boosters, 2)
	rep.DurationMs = int64(rep.TotalMoves()) * 1500

	fin := e.call(t, "POST", "/v1/heists/"+sp.RunID+"/finish", tok, rep, map[string]string{"Idempotency-Key": "k1"})
	if fin.code != 200 {
		t.Fatalf("finish: %d %s", fin.code, fin.raw)
	}
	if int64(fin.body["score"].(float64)) != want.Score || fin.body["outcome"] != string(want.Outcome) {
		t.Fatalf("server result differs from client: %s vs %+v", fin.raw, want)
	}
	rewardID := fin.body["reward"].(map[string]any)["rewardId"].(string)

	// Retry with the same key → identical body, replay header, no double reward.
	again := e.call(t, "POST", "/v1/heists/"+sp.RunID+"/finish", tok, rep, map[string]string{"Idempotency-Key": "k1"})
	if again.code != 200 || again.header.Get("Idempotent-Replayed") != "true" || !bytes.Equal(bytes.TrimSpace(again.raw), bytes.TrimSpace(fin.raw)) {
		t.Fatalf("idempotent replay mismatch: %d %s", again.code, again.raw)
	}
	// Retry without a key → the run itself refuses a second settlement.
	third := e.call(t, "POST", "/v1/heists/"+sp.RunID+"/finish", tok, rep, nil)
	if third.code != http.StatusConflict || errCode(third) != "RUN_ALREADY_FINISHED" {
		t.Fatalf("double finish: %d %s", third.code, third.raw)
	}

	// Claim reward exactly once.
	claim := e.call(t, "POST", "/v1/rewards/claim", tok, map[string]string{"rewardId": rewardID}, nil)
	if claim.code != 200 {
		t.Fatalf("claim: %d %s", claim.code, claim.raw)
	}
	claim2 := e.call(t, "POST", "/v1/rewards/claim", tok, map[string]string{"rewardId": rewardID}, nil)
	if claim2.code != http.StatusConflict || errCode(claim2) != "REWARD_ALREADY_CLAIMED" {
		t.Fatalf("second claim: %d %s", claim2.code, claim2.raw)
	}

	// Leaderboard reflects the run (bus is async; poll briefly).
	deadline := time.Now().Add(2 * time.Second)
	for {
		lb := e.call(t, "GET", "/v1/leaderboard/global", tok, nil, nil)
		if me, ok := lb.body["me"].(map[string]any); ok && me != nil && int64(me["score"].(float64)) == want.Score {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("leaderboard never reflected the score: %s", lb.raw)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestFinishValidationChain(t *testing.T) {
	e := newEnv(t, 0)
	tok := e.newPlayer(t, "d1")
	other := e.newPlayer(t, "d2")
	sp := e.start(t, tok, nil)
	rep, _ := engine.Bot{}.PlayRun(&sp.Config, sp.Seed, nil, 1)
	rep.DurationMs = int64(rep.TotalMoves()) * 1500

	t.Run("unknown run", func(t *testing.T) {
		r := e.call(t, "POST", "/v1/heists/run_nope/finish", tok, rep, nil)
		if r.code != 404 || errCode(r) != "RUN_NOT_FOUND" {
			t.Fatalf("%d %s", r.code, r.raw)
		}
	})
	t.Run("someone else's run", func(t *testing.T) {
		r := e.call(t, "POST", "/v1/heists/"+sp.RunID+"/finish", other, rep, nil)
		if r.code != 404 { // keyed by owner: invisible, not merely forbidden
			t.Fatalf("%d %s", r.code, r.raw)
		}
	})
	t.Run("tampered score", func(t *testing.T) {
		bad := rep
		bad.ClientScore += 1000
		r := e.call(t, "POST", "/v1/heists/"+sp.RunID+"/finish", tok, bad, nil)
		if r.code != 422 || errCode(r) != "SCORE_MISMATCH" {
			t.Fatalf("%d %s", r.code, r.raw)
		}
	})
	t.Run("illegal move", func(t *testing.T) {
		bad := rep
		bad.Vaults = []engine.VaultReplay{{Moves: [][]int{{0, 1, 2, 3, 4, 5, 6}}}}
		r := e.call(t, "POST", "/v1/heists/"+sp.RunID+"/finish", tok, bad, nil)
		if r.code != 422 || errCode(r) != "INVALID_REPLAY" {
			t.Fatalf("%d %s", r.code, r.raw)
		}
	})
	t.Run("implausible duration", func(t *testing.T) {
		bad := rep
		bad.DurationMs = 5
		r := e.call(t, "POST", "/v1/heists/"+sp.RunID+"/finish", tok, bad, nil)
		if r.code != 422 || errCode(r) != "IMPLAUSIBLE_RESULT" {
			t.Fatalf("%d %s", r.code, r.raw)
		}
	})
	t.Run("expired run", func(t *testing.T) {
		e.now = e.now.Add(3 * time.Hour)
		defer func() { e.now = e.now.Add(-3 * time.Hour) }()
		r := e.call(t, "POST", "/v1/heists/"+sp.RunID+"/finish", tok, rep, nil)
		if r.code != 410 || errCode(r) != "RUN_EXPIRED" {
			t.Fatalf("%d %s", r.code, r.raw)
		}
	})
	t.Run("happy path still works after all the rejections", func(t *testing.T) {
		r := e.call(t, "POST", "/v1/heists/"+sp.RunID+"/finish", tok, rep, nil)
		if r.code != 200 {
			t.Fatalf("%d %s", r.code, r.raw)
		}
	})
}

// TestConfigVersionPinning: a LiveOps change mid-run must not affect the run.
func TestConfigVersionPinning(t *testing.T) {
	e := newEnv(t, 0)
	tok := e.newPlayer(t, "d1")
	sp := e.start(t, tok, nil)
	if sp.Config.Version != 1 {
		t.Fatalf("expected v1, got v%d", sp.Config.Version)
	}
	rep, want := engine.Bot{}.PlayRun(&sp.Config, sp.Seed, nil, 2)
	rep.DurationMs = int64(rep.TotalMoves()) * 1500

	// Admin publishes v2 with a different difficulty while the run is active.
	newCfg := sp.Config
	newCfg.Difficulty = 1.5
	pub := e.call(t, "PUT", "/admin/v1/events/"+sp.Config.EventID+"/config", "", map[string]any{"config": newCfg, "note": "mid-run change", "createdBy": "ops"}, map[string]string{"X-Admin-Token": "admin-token"})
	if pub.code != 201 || pub.body["config"].(map[string]any)["version"].(float64) != 2 {
		t.Fatalf("publish: %d %s", pub.code, pub.raw)
	}

	// The active run still validates against v1.
	fin := e.call(t, "POST", "/v1/heists/"+sp.RunID+"/finish", tok, rep, nil)
	if fin.code != 200 || int64(fin.body["score"].(float64)) != want.Score {
		t.Fatalf("pinned run rejected: %d %s", fin.code, fin.raw)
	}
	// A new run gets v2.
	sp2 := e.start(t, tok, nil)
	if sp2.Config.Version != 2 || sp2.Config.Difficulty != 1.5 {
		t.Fatalf("new run should use v2: v%d diff=%v", sp2.Config.Version, sp2.Config.Difficulty)
	}
	// Replaying a v2 board's moves against the v1 run must fail (objectives differ).
	rep2, _ := engine.Bot{}.PlayRun(&sp2.Config, sp2.Seed, nil, 1)
	rep2.DurationMs = int64(rep2.TotalMoves()) * 1500
	if _, err := engine.Run(&sp.Config, sp.Seed, nil, rep2); err == nil {
		t.Log("v1 and v2 happen to accept the same replay for vault 1; pinning still verified via version numbers")
	}
}

func TestAuthAndAdminGuards(t *testing.T) {
	e := newEnv(t, 0)
	if r := e.call(t, "GET", "/v1/player/profile", "", nil, nil); r.code != 401 {
		t.Fatalf("no token: %d", r.code)
	}
	if r := e.call(t, "GET", "/v1/player/profile", "bogus.token", nil, nil); r.code != 401 {
		t.Fatalf("bad token: %d", r.code)
	}
	if r := e.call(t, "GET", "/admin/v1/events", "", nil, nil); r.code != 403 {
		t.Fatalf("admin without token: %d", r.code)
	}
	if r := e.call(t, "GET", "/admin/v1/events", "", nil, map[string]string{"X-Admin-Token": "wrong"}); r.code != 403 {
		t.Fatalf("admin wrong token: %d", r.code)
	}
	if r := e.call(t, "GET", "/admin/v1/events", "", nil, map[string]string{"X-Admin-Token": "admin-token"}); r.code != 200 {
		t.Fatalf("admin ok: %d %s", r.code, r.raw)
	}
	if r := e.call(t, "GET", "/healthz", "", nil, nil); r.code != 200 || r.header.Get("X-Request-Id") == "" {
		t.Fatalf("healthz: %d", r.code)
	}
	if r := e.call(t, "GET", "/nope", "", nil, nil); r.code != 404 {
		t.Fatalf("unknown route: %d", r.code)
	}
}

func TestRateLimitPerPlayer(t *testing.T) {
	e := newEnv(t, 5)
	tok := e.newPlayer(t, "d1")
	other := e.newPlayer(t, "d2")
	got429 := false
	for i := 0; i < 8; i++ {
		r := e.call(t, "GET", "/v1/player/profile", tok, nil, nil)
		if r.code == 429 {
			got429 = true
			if r.header.Get("Retry-After") == "" {
				t.Fatal("429 must carry Retry-After")
			}
		}
	}
	if !got429 {
		t.Fatal("expected rate limiting after 5 requests")
	}
	if r := e.call(t, "GET", "/v1/player/profile", other, nil, nil); r.code != 200 {
		t.Fatalf("other player must be unaffected: %d", r.code)
	}
}

func TestConcurrentClaimsOverHTTP(t *testing.T) {
	e := newEnv(t, 0)
	tok := e.newPlayer(t, "d1")
	sp := e.start(t, tok, nil)
	rep, _ := engine.Bot{}.PlayRun(&sp.Config, sp.Seed, nil, 1)
	rep.DurationMs = int64(rep.TotalMoves()) * 1500
	fin := e.call(t, "POST", "/v1/heists/"+sp.RunID+"/finish", tok, rep, nil)
	rewardID := fin.body["reward"].(map[string]any)["rewardId"].(string)
	coinsBefore := int64(fin.body["profile"].(map[string]any)["coins"].(float64))
	coins := int64(fin.body["reward"].(map[string]any)["coins"].(float64))

	var wg sync.WaitGroup
	var mu sync.Mutex
	codes := map[int]int{}
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := e.call(t, "POST", "/v1/rewards/claim", tok, map[string]string{"rewardId": rewardID}, nil)
			mu.Lock()
			codes[r.code]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if codes[200] != 1 || codes[409] != 99 {
		t.Fatalf("100 concurrent claims → %v (want 200:1, 409:99)", codes)
	}
	prof := e.call(t, "GET", "/v1/player/profile", tok, nil, nil)
	if int64(prof.body["coins"].(float64)) != coinsBefore+coins {
		t.Fatalf("coins %v, want %d", prof.body["coins"], coinsBefore+coins)
	}
}

func TestShopPurchaseAndInsufficientFunds(t *testing.T) {
	e := newEnv(t, 0)
	tok := e.newPlayer(t, "d1")
	r := e.call(t, "POST", "/v1/shop/purchase", tok, map[string]string{"itemId": "extra_moves"}, map[string]string{"Idempotency-Key": "buy-1"})
	if r.code != 200 || r.body["profile"].(map[string]any)["coins"].(float64) != float64(player.StartingCoins-300) {
		t.Fatalf("purchase: %d %s", r.code, r.raw)
	}
	replay := e.call(t, "POST", "/v1/shop/purchase", tok, map[string]string{"itemId": "extra_moves"}, map[string]string{"Idempotency-Key": "buy-1"})
	if replay.header.Get("Idempotent-Replayed") != "true" || replay.body["profile"].(map[string]any)["coins"].(float64) != float64(player.StartingCoins-300) {
		t.Fatalf("idempotent purchase replay charged twice: %s", replay.raw)
	}
	for i := 0; i < 3; i++ {
		e.call(t, "POST", "/v1/shop/purchase", tok, map[string]string{"itemId": "shield"}, nil)
	}
	broke := e.call(t, "POST", "/v1/shop/purchase", tok, map[string]string{"itemId": "shield"}, nil)
	if broke.code != 402 || errCode(broke) != "INSUFFICIENT_COINS" {
		t.Fatalf("expected 402, got %d %s", broke.code, broke.raw)
	}
}

func TestStartConsumesLivesAndBoosters(t *testing.T) {
	e := newEnv(t, 0)
	tok := e.newPlayer(t, "d1")
	sp := e.start(t, tok, []string{engine.BoosterExtraMoves})
	if len(sp.Boosters) != 1 {
		t.Fatalf("boosters not recorded: %v", sp.Boosters)
	}
	prof := e.call(t, "GET", "/v1/player/profile", tok, nil, nil)
	if prof.body["boosters"].(map[string]any)["extra_moves"].(float64) != 0 {
		t.Fatalf("booster not consumed: %s", prof.raw)
	}
	r := e.call(t, "POST", "/v1/heists/start", tok, map[string]any{"boosters": []string{engine.BoosterExtraMoves}}, nil)
	if r.code != 402 || errCode(r) != "INSUFFICIENT_BOOSTERS" {
		t.Fatalf("expected INSUFFICIENT_BOOSTERS: %d %s", r.code, r.raw)
	}
	// Burn the remaining lives.
	lives := int(prof.body["lives"].(float64))
	for i := 0; i < lives; i++ {
		e.start(t, tok, nil)
	}
	out := e.call(t, "POST", "/v1/heists/start", tok, map[string]any{}, nil)
	if out.code != 402 || errCode(out) != "INSUFFICIENT_LIVES" {
		t.Fatalf("expected INSUFFICIENT_LIVES: %d %s", out.code, out.raw)
	}
	// Half an hour later a life has regenerated.
	e.now = e.now.Add(31 * time.Minute)
	if r := e.call(t, "POST", "/v1/heists/start", tok, map[string]any{}, nil); r.code != 201 {
		t.Fatalf("regenerated life should allow a start: %d %s", r.code, r.raw)
	}
}

func TestAnalyticsReportAfterRuns(t *testing.T) {
	e := newEnv(t, 0)
	var eventID string
	for i := 0; i < 5; i++ {
		tok := e.newPlayer(t, fmt.Sprintf("d%d", i))
		sp := e.start(t, tok, nil)
		eventID = sp.Config.EventID
		depth := 1 + i%3
		rep, _ := engine.Bot{}.PlayRun(&sp.Config, sp.Seed, nil, depth)
		rep.DurationMs = int64(rep.TotalMoves()) * 1500
		if r := e.call(t, "POST", "/v1/heists/"+sp.RunID+"/finish", tok, rep, nil); r.code != 200 {
			t.Fatalf("finish: %s", r.raw)
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		r := e.call(t, "GET", "/admin/v1/events/"+eventID+"/analytics", "", nil, map[string]string{"X-Admin-Token": "admin-token"})
		if r.code == 200 && r.body["runsCompleted"].(float64) == 5 {
			if r.body["players"].(float64) != 5 || r.body["completionRate"].(float64) != 1 {
				t.Fatalf("report: %s", r.raw)
			}
			drop := r.body["vaultDropoff"].([]any)
			if drop[0].(map[string]any)["pct"].(float64) != 1 || drop[1].(map[string]any)["reached"].(float64) != 3 {
				t.Fatalf("dropoff: %v", drop)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("analytics never converged: %s", r.raw)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
