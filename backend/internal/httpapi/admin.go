package httpapi

import (
	"net/http"
	"strconv"
	"time"

	"github.com/atakank/vault-rush/backend/internal/domain"
	"github.com/atakank/vault-rush/backend/internal/experiment"
	"github.com/atakank/vault-rush/backend/pkg/engine"
)

func (s *server) adminListEvents(w http.ResponseWriter, r *http.Request) {
	window, _ := strconv.Atoi(r.URL.Query().Get("window"))
	if window <= 0 {
		window = 7
	}
	metas, err := s.d.Liveops.ListWindow(r.Context(), window)
	if err != nil {
		fail(w, err, "")
		return
	}
	now := s.d.Liveops.Now()
	out := make([]eventView, 0, len(metas))
	for _, m := range metas {
		out = append(out, toEventView(m, now))
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": out})
}

func (s *server) adminGetEvent(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("eventId")
	meta, err := s.d.Liveops.GetMeta(r.Context(), id)
	if err != nil {
		fail(w, err, "EVENT_NOT_FOUND")
		return
	}
	cfg, err := s.d.Liveops.GetConfig(r.Context(), id, meta.ConfigVersion)
	if err != nil {
		fail(w, err, "EVENT_NOT_FOUND")
		return
	}
	versions, err := s.d.Liveops.Versions(r.Context(), id)
	if err != nil {
		fail(w, err, "")
		return
	}
	if versions == nil {
		versions = []domain.ConfigVersionInfo{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"event": toEventView(meta, s.d.Liveops.Now()), "config": cfg, "versions": versions})
}

func (s *server) adminGetConfigVersion(w http.ResponseWriter, r *http.Request) {
	v, err := strconv.Atoi(r.PathValue("version"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "version must be an integer")
		return
	}
	cfg, err := s.d.Liveops.GetConfig(r.Context(), r.PathValue("eventId"), v)
	if err != nil {
		fail(w, err, "EVENT_NOT_FOUND")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"config": cfg})
}

type publishConfigReq struct {
	Config    engine.Config `json:"config"`
	Note      string        `json:"note"`
	CreatedBy string        `json:"createdBy"`
}

func (s *server) adminPublishConfig(w http.ResponseWriter, r *http.Request) {
	var req publishConfigReq
	if !decode(w, r, &req) {
		return
	}
	if req.CreatedBy == "" {
		req.CreatedBy = "admin"
	}
	meta, cfg, err := s.d.Liveops.PublishConfig(r.Context(), r.PathValue("eventId"), req.Config, req.Note, req.CreatedBy)
	if err != nil {
		fail(w, err, "EVENT_NOT_FOUND")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"event": toEventView(meta, s.d.Liveops.Now()), "config": cfg})
}

type createEventReq struct {
	EventID  string        `json:"eventId"`
	Name     string        `json:"name"`
	Theme    string        `json:"theme"`
	StartsAt time.Time     `json:"startsAt"`
	EndsAt   time.Time     `json:"endsAt"`
	Config   engine.Config `json:"config"`
}

func (s *server) adminCreateEvent(w http.ResponseWriter, r *http.Request) {
	var req createEventReq
	if !decode(w, r, &req) {
		return
	}
	if req.EventID == "" || req.Name == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "eventId and name are required")
		return
	}
	now := s.d.Liveops.Now()
	meta := &domain.EventMeta{ID: req.EventID, Name: req.Name, Theme: req.Theme, StartsAt: req.StartsAt, EndsAt: req.EndsAt, CreatedAt: now, UpdatedAt: now}
	cfg := req.Config
	if cfg.Seed == 0 {
		cfg.Seed = s.d.Liveops.Seed(req.EventID)
	}
	if len(cfg.Vaults) == 0 {
		def := engine.DefaultConfig(req.EventID, cfg.Seed, now)
		def.Difficulty, def.LootMultiplier = nz(cfg.Difficulty, def.Difficulty), nz(cfg.LootMultiplier, def.LootMultiplier)
		cfg = def
	}
	cfg.CreatedBy = "admin"
	if err := s.d.Liveops.Create(r.Context(), meta, &cfg); err != nil {
		fail(w, err, "")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"event": toEventView(meta, now), "config": cfg})
}

func nz(v, def float64) float64 {
	if v == 0 {
		return def
	}
	return v
}

func (s *server) adminAnalytics(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("eventId")
	vaults := 5
	if meta, err := s.d.Liveops.GetMeta(r.Context(), id); err == nil {
		if cfg, err := s.d.Liveops.GetConfig(r.Context(), id, meta.ConfigVersion); err == nil {
			vaults = len(cfg.Vaults)
		}
	}
	rep, err := s.d.Analytics.Report(r.Context(), id, vaults)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "DEPENDENCY_UNAVAILABLE", "analytics temporarily unavailable")
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (s *server) adminExperiments(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"experiments": experiment.Definitions()})
}

func (s *server) adminGetPlayer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("playerId")
	p, err := s.d.Players.Get(r.Context(), id)
	if err != nil {
		fail(w, err, "PLAYER_NOT_FOUND")
		return
	}
	runs, err := s.d.Store.Runs().ListByPlayer(r.Context(), id, 20)
	if err != nil {
		fail(w, err, "")
		return
	}
	if runs == nil {
		runs = []*domain.Run{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": s.d.Players.View(p), "runs": runs})
}

type grantReq struct {
	Coins    int64          `json:"coins"`
	Lives    int            `json:"lives"`
	Boosters map[string]int `json:"boosters"`
}

func (s *server) adminGrant(w http.ResponseWriter, r *http.Request) {
	var req grantReq
	if !decode(w, r, &req) {
		return
	}
	p, err := s.d.Players.Mutate(r.Context(), r.PathValue("playerId"), func(p *domain.Player) error {
		p.Coins += req.Coins
		if p.Coins < 0 {
			p.Coins = 0
		}
		p.Lives = max(0, min(p.MaxLives, p.Lives+req.Lives))
		for k, v := range req.Boosters {
			if p.Boosters == nil {
				p.Boosters = map[string]int{}
			}
			p.Boosters[k] = max(0, p.Boosters[k]+v)
		}
		return nil
	})
	if err != nil {
		fail(w, err, "PLAYER_NOT_FOUND")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": s.d.Players.View(p)})
}

func (s *server) adminSystem(w http.ResponseWriter, r *http.Request) {
	deps, _ := s.depsHealth(r)
	out := map[string]any{
		"version":       s.d.Version,
		"uptimeSeconds": int64(time.Since(s.d.StartedAt).Seconds()),
		"storage":       s.d.Store.Name(),
		"cache":         s.d.Cache.Name(),
		"queue":         s.d.QueueMode,
		"deps":          deps,
	}
	if s.d.Bus != nil {
		out["telemetry"] = s.d.Bus.Stats()
	}
	writeJSON(w, http.StatusOK, out)
}
