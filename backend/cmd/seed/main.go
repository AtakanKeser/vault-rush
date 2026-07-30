// Command seed simulates a population of bot players against a running API so
// the leaderboard, analytics and LiveOps dashboard have realistic data. It
// doubles as an end-to-end smoke test: every run goes through the real
// start → play (deterministic engine) → finish → claim path.
//
//	go run ./cmd/seed -base http://localhost:8080 -players 200 -runs 3
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/atakank/vault-rush/backend/pkg/engine"
)

var names = []string{"Atakan", "Villain77", "JohnDoe", "Player_1943", "NightOwl", "Sable", "Kestrel", "Moth", "Cipher", "Glass", "Fable", "Rook", "Juno", "Vesper", "Halcyon", "Nova", "Quill", "Ember", "Zephyr", "Onyx", "Marlow", "Isolde", "Tarn", "Bram", "Wren", "Lux", "Odile", "Sorrel", "Kit", "Pike"}

type client struct {
	base  string
	token string
	http  *http.Client
}

func (c *client) do(method, path string, body any, out any, headers map[string]string) (int, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rd)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 400 {
		return res.StatusCode, fmt.Errorf("%s %s → %d: %s", method, path, res.StatusCode, string(data))
	}
	if out != nil {
		return res.StatusCode, json.Unmarshal(data, out)
	}
	return res.StatusCode, nil
}

type startResp struct {
	RunID    string        `json:"runId"`
	Seed     uint32        `json:"seed"`
	Boosters []string      `json:"boosters"`
	Config   engine.Config `json:"config"`
}

type finishResp struct {
	Outcome string `json:"outcome"`
	Score   int64  `json:"score"`
	Reward  *struct {
		RewardID string `json:"rewardId"`
	} `json:"reward"`
}

func main() {
	base := flag.String("base", "http://localhost:8080", "API base URL")
	players := flag.Int("players", 100, "number of bot players")
	runs := flag.Int("runs", 2, "runs per player")
	conc := flag.Int("concurrency", 16, "parallel players")
	flag.Parse()

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	var ok, failed, claimed atomic.Int64
	var best atomic.Int64
	sem := make(chan struct{}, *conc)
	var wg sync.WaitGroup
	start := time.Now()

	for i := 0; i < *players; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			c := &client{base: *base, http: &http.Client{Timeout: 10 * time.Second}}
			name := names[i%len(names)]
			if i >= len(names) {
				name = fmt.Sprintf("%s%d", name, i/len(names))
			}
			var created struct {
				Token string `json:"token"`
			}
			if _, err := c.do("POST", "/v1/player", map[string]string{"deviceId": fmt.Sprintf("seed-%d-%d", start.Unix(), i), "displayName": name}, &created, nil); err != nil {
				fmt.Fprintln(os.Stderr, err)
				failed.Add(1)
				return
			}
			c.token = created.Token
			local := rand.New(rand.NewSource(int64(i) * 7919))
			for r := 0; r < *runs; r++ {
				var st startResp
				var boosters []string
				if local.Intn(4) == 0 {
					boosters = []string{engine.BoosterExtraMoves}
				}
				code, err := c.do("POST", "/v1/heists/start", map[string]any{"boosters": boosters}, &st, nil)
				if err != nil && code == http.StatusPaymentRequired && len(boosters) > 0 {
					code, err = c.do("POST", "/v1/heists/start", map[string]any{}, &st, nil) // booster spent: play without it
				}
				if err != nil {
					if code != http.StatusPaymentRequired { // out of lives is expected for greedy bots
						fmt.Fprintln(os.Stderr, err)
						failed.Add(1)
					}
					return
				}
				// Player archetypes: cautious (escape early), balanced, reckless.
				bot := engine.Bot{MaxChain: 4 + local.Intn(4)}
				maxVault := 1 + local.Intn(len(st.Config.Vaults))
				if local.Intn(3) == 0 {
					bot.Greedy = true
					maxVault = len(st.Config.Vaults)
				}
				rep, res := bot.PlayRun(&st.Config, st.Seed, st.Boosters, maxVault)
				rep.DurationMs = int64(rep.TotalMoves())*int64(900+local.Intn(2500)) + 3000
				var fin finishResp
				if _, err := c.do("POST", "/v1/heists/"+st.RunID+"/finish", rep, &fin, map[string]string{"Idempotency-Key": fmt.Sprintf("seed-%s", st.RunID)}); err != nil {
					fmt.Fprintln(os.Stderr, err)
					failed.Add(1)
					continue
				}
				if fin.Score != res.Score {
					fmt.Fprintf(os.Stderr, "score mismatch for %s: client %d server %d\n", st.RunID, res.Score, fin.Score)
					failed.Add(1)
				}
				ok.Add(1)
				for {
					cur := best.Load()
					if fin.Score <= cur || best.CompareAndSwap(cur, fin.Score) {
						break
					}
				}
				if fin.Reward != nil && local.Intn(5) != 0 {
					if _, err := c.do("POST", "/v1/rewards/claim", map[string]string{"rewardId": fin.Reward.RewardID}, nil, nil); err == nil {
						claimed.Add(1)
					}
				}
				if local.Intn(6) == 0 {
					_, _ = c.do("POST", "/v1/shop/purchase", map[string]string{"itemId": "extra_moves"}, nil, nil)
				}
			}
		}(i)
	}
	wg.Wait()
	_ = rng
	fmt.Printf("seeded %d players in %s: runs ok=%d failed=%d claimed=%d best=%d\n", *players, time.Since(start).Round(time.Millisecond), ok.Load(), failed.Load(), claimed.Load(), best.Load())
	if failed.Load() > 0 && ok.Load() == 0 {
		os.Exit(1)
	}
}
