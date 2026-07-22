package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/atakank/vault-rush/backend/internal/cache"
	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/player"
	"github.com/atakank/vault-rush/backend/internal/shop"
	"github.com/atakank/vault-rush/backend/pkg/engine"
)

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "request body is required")
			return false
		}
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON: "+err.Error())
		return false
	}
	return true
}

// ---- player ----

type createPlayerReq struct {
	DeviceID    string `json:"deviceId"`
	DisplayName string `json:"displayName"`
}

type createPlayerResp struct {
	PlayerID string         `json:"playerId"`
	Token    string         `json:"token"`
	Profile  player.Profile `json:"profile"`
}

func (s *server) createPlayer(w http.ResponseWriter, r *http.Request) {
	var req createPlayerReq
	if !decode(w, r, &req) {
		return
	}
	if req.DeviceID == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "deviceId is required")
		return
	}
	p, token, created, err := s.d.Players.CreateOrResume(r.Context(), req.DeviceID, req.DisplayName)
	if err != nil {
		fail(w, err, "PLAYER_NOT_FOUND")
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, createPlayerResp{PlayerID: p.ID, Token: token, Profile: s.d.Players.View(p)})
}

func (s *server) profile(w http.ResponseWriter, r *http.Request) {
	p, err := s.d.Players.Get(r.Context(), PlayerID(r.Context()))
	if err != nil {
		fail(w, err, "PLAYER_NOT_FOUND")
		return
	}
	writeJSON(w, http.StatusOK, s.d.Players.View(p))
}

// ---- events ----

type eventView struct {
	EventID       string             `json:"eventId"`
	Name          string             `json:"name"`
	Theme         string             `json:"theme"`
	Status        domain.EventStatus `json:"status"`
	StartsAt      time.Time          `json:"startsAt"`
	EndsAt        time.Time          `json:"endsAt"`
	ConfigVersion int                `json:"configVersion"`
}

func toEventView(m *domain.EventMeta, now time.Time) eventView {
	return eventView{EventID: m.ID, Name: m.Name, Theme: m.Theme, Status: m.StatusAt(now), StartsAt: m.StartsAt, EndsAt: m.EndsAt, ConfigVersion: m.ConfigVersion}
}

type currentEventResp struct {
	Event              eventView      `json:"event"`
	Config             *engine.Config `json:"config"`
	LeaderboardPreview []cache.Entry  `json:"leaderboardPreview"`
	Me                 *cache.Entry   `json:"me"`
	ServerTime         time.Time      `json:"serverTime"`
}

func (s *server) currentEvent(w http.ResponseWriter, r *http.Request) {
	meta, cfg, err := s.d.Liveops.Current(r.Context())
	if err != nil {
		fail(w, err, "EVENT_NOT_FOUND")
		return
	}
	resp := currentEventResp{Event: toEventView(meta, s.d.Liveops.Now()), Config: cfg, LeaderboardPreview: []cache.Entry{}, ServerTime: s.d.Liveops.Now()}
	if board, err := s.d.Leaderboard.Global(r.Context(), meta.ID, PlayerID(r.Context()), 3); err == nil {
		resp.LeaderboardPreview = board.Entries
		resp.Me = board.Me
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---- heists ----

type startReq struct {
	Boosters []string `json:"boosters"`
}

type startResp struct {
	RunID         string         `json:"runId"`
	PlayerID      string         `json:"playerId"`
	EventID       string         `json:"eventId"`
	Seed          uint32         `json:"seed"`
	ConfigVersion int            `json:"configVersion"`
	Boosters      []string       `json:"boosters"`
	StartedAt     time.Time      `json:"startedAt"`
	ExpiresAt     time.Time      `json:"expiresAt"`
	Config        *engine.Config `json:"config"`
}

func (s *server) startHeist(w http.ResponseWriter, r *http.Request) {
	var req startReq
	if r.ContentLength != 0 {
		if !decode(w, r, &req) {
			return
		}
	}
	res, err := s.d.Gameplay.Start(r.Context(), PlayerID(r.Context()), req.Boosters)
	if err != nil {
		fail(w, err, "PLAYER_NOT_FOUND")
		return
	}
	run := res.Run
	writeJSON(w, http.StatusCreated, startResp{
		RunID: run.ID, PlayerID: run.PlayerID, EventID: run.EventID, Seed: run.Seed, ConfigVersion: run.ConfigVersion,
		Boosters: run.Boosters, StartedAt: run.StartedAt, ExpiresAt: run.ExpiresAt, Config: res.Config,
	})
}

type finishResp struct {
	RunID         string         `json:"runId"`
	Outcome       engine.Outcome `json:"outcome"`
	Score         int64          `json:"score"`
	Loot          int64          `json:"loot"`
	VaultReached  int            `json:"vaultReached"`
	VaultsCracked int            `json:"vaultsCracked"`
	Multiplier    float64        `json:"multiplier"`
	Reward        *domain.Reward `json:"reward"`
	Profile       player.Profile `json:"profile"`
}

func (s *server) finishHeist(w http.ResponseWriter, r *http.Request) {
	var rep engine.Replay
	if !decode(w, r, &rep) {
		return
	}
	res, err := s.d.Gameplay.Finish(r.Context(), PlayerID(r.Context()), r.PathValue("runId"), rep)
	if err != nil {
		fail(w, err, "RUN_NOT_FOUND")
		return
	}
	writeJSON(w, http.StatusOK, finishResp{
		RunID: res.Run.ID, Outcome: res.Result.Outcome, Score: res.Result.Score, Loot: res.Result.Loot,
		VaultReached: res.Result.VaultReached, VaultsCracked: res.Result.VaultsCracked, Multiplier: res.Result.Multiplier,
		Reward: res.Reward, Profile: s.d.Players.View(res.Player),
	})
}

// ---- leaderboard ----

func (s *server) resolveEventID(r *http.Request) (string, error) {
	if id := r.URL.Query().Get("eventId"); id != "" {
		return id, nil
	}
	meta, _, err := s.d.Liveops.Current(r.Context())
	if err != nil {
		return "", err
	}
	return meta.ID, nil
}

func (s *server) leaderboardGlobal(w http.ResponseWriter, r *http.Request) {
	eventID, err := s.resolveEventID(r)
	if err != nil {
		fail(w, err, "EVENT_NOT_FOUND")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	board, err := s.d.Leaderboard.Global(r.Context(), eventID, PlayerID(r.Context()), limit)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "DEPENDENCY_UNAVAILABLE", "leaderboard temporarily unavailable")
		return
	}
	writeJSON(w, http.StatusOK, board)
}

func (s *server) leaderboardFriends(w http.ResponseWriter, r *http.Request) {
	eventID, err := s.resolveEventID(r)
	if err != nil {
		fail(w, err, "EVENT_NOT_FOUND")
		return
	}
	board, err := s.d.Leaderboard.Rivals(r.Context(), eventID, PlayerID(r.Context()))
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "DEPENDENCY_UNAVAILABLE", "leaderboard temporarily unavailable")
		return
	}
	writeJSON(w, http.StatusOK, board)
}

// ---- rewards ----

func (s *server) listRewards(w http.ResponseWriter, r *http.Request) {
	list, err := s.d.Rewards.ListPending(r.Context(), PlayerID(r.Context()))
	if err != nil {
		fail(w, err, "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rewards": list})
}

type claimReq struct {
	RewardID string `json:"rewardId"`
}

func (s *server) claimReward(w http.ResponseWriter, r *http.Request) {
	var req claimReq
	if !decode(w, r, &req) {
		return
	}
	if req.RewardID == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "rewardId is required")
		return
	}
	rw, p, err := s.d.Rewards.Claim(r.Context(), PlayerID(r.Context()), req.RewardID)
	if err != nil {
		fail(w, err, "REWARD_NOT_FOUND")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"rewardId": rw.ID, "coins": rw.Coins, "boosters": rw.Boosters, "status": rw.Status, "profile": s.d.Players.View(p),
	})
}

// ---- shop ----

func (s *server) catalog(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": shop.Catalog})
}

type purchaseReq struct {
	ItemID string `json:"itemId"`
}

func (s *server) purchase(w http.ResponseWriter, r *http.Request) {
	var req purchaseReq
	if !decode(w, r, &req) {
		return
	}
	p, err := s.d.Shop.Purchase(r.Context(), PlayerID(r.Context()), req.ItemID)
	if err != nil {
		fail(w, err, "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": s.d.Players.View(p)})
}

// ---- ops ----

func (s *server) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) readyz(w http.ResponseWriter, r *http.Request) {
	if draining.Load() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "draining"})
		return
	}
	deps, ok := s.depsHealth(r)
	status := http.StatusOK
	state := "ok"
	if !ok {
		status = http.StatusServiceUnavailable
		state = "degraded"
	}
	writeJSON(w, status, map[string]any{"status": state, "deps": deps})
}

func (s *server) metrics(w http.ResponseWriter, _ *http.Request) {
	snap := s.metricsReg.Snapshot()
	if s.d.Bus != nil {
		snap["telemetry"] = s.d.Bus.Stats()
	}
	writeJSON(w, http.StatusOK, snap)
}
