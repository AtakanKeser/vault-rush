/**
 * Vault Rush client — application state machine.
 *
 * Flow: boot → (welcome) → home → play (vault 1..n with escape/deeper
 * decisions) → result → home. The run itself is simulated locally with the
 * deterministic engine; the server replays the exact same moves to score it.
 */
import './styles.css';
import { api, ApiError, savedName, uuid, type CurrentEvent, type FinishResponse, type LBEntry, type Profile, type Reward, type ShopItem, type Board } from './api';
import { RNG } from './engine/rng';
import { Sim, runReplay, escapeScore, bustScore, scaledObjectives, difficultyPct, type Config, type MoveResult, type Objectives, type VaultReplay } from './engine/engine';
import { BoardView } from './game/board';
import { preloadTiles, TILE_STYLE } from './game/tiles';
import { sound } from './game/audio';
import { fmt, multStr } from './ui/dom';
import {
  banner,
  confirmModal,
  decisionModal,
  errorScreen,
  homeScreen,
  leaderboardScreen,
  loadingScreen,
  playScreen,
  resultScreen,
  shopScreen,
  toast,
  welcomeScreen,
  type PlayHud,
} from './ui/screens';

interface ActiveRun {
  runId: string;
  seed: number;
  config: Config;
  boosters: string[];
  eventName: string;
  eventId: string;
  rng: RNG;
  vaultIndex: number;
  sim: Sim;
  vaults: VaultReplay[];
  currentMoves: number[][];
  totalLoot: number;
  startedAt: number;
  idemKey: string;
  expiresAt: string;
}

interface PersistedRun {
  runId: string;
  seed: number;
  config: Config;
  boosters: string[];
  eventName: string;
  eventId: string;
  vaults: VaultReplay[];
  currentMoves: number[][];
  totalLoot: number;
  startedAt: number;
  idemKey: string;
  expiresAt: string;
}

const RUN_KEY = 'vr_run';

const state = {
  profile: null as Profile | null,
  current: null as CurrentEvent | null,
  boosters: new Set<string>(),
  run: null as ActiveRun | null,
  starting: false,
};

const screenEl = document.getElementById('screen')!;
const overlayEl = document.getElementById('overlay')!;
let board: BoardView | null = null;

function show(el: HTMLElement): void {
  if (board) {
    board.destroy();
    board = null;
  }
  overlayEl.replaceChildren();
  screenEl.replaceChildren(el);
}

// ---------------------------------------------------------------- persistence

function persistRun(): void {
  const r = state.run;
  try {
    if (!r) {
      localStorage.removeItem(RUN_KEY);
      return;
    }
    const p: PersistedRun = {
      runId: r.runId,
      seed: r.seed,
      config: r.config,
      boosters: r.boosters,
      eventName: r.eventName,
      eventId: r.eventId,
      vaults: r.vaults,
      currentMoves: r.currentMoves,
      totalLoot: r.totalLoot,
      startedAt: r.startedAt,
      idemKey: r.idemKey,
      expiresAt: r.expiresAt,
    };
    localStorage.setItem(RUN_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function loadPersistedRun(): PersistedRun | null {
  try {
    const raw = localStorage.getItem(RUN_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PersistedRun;
    if (new Date(p.expiresAt).getTime() < Date.now()) {
      localStorage.removeItem(RUN_KEY);
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

/** Rebuild an in-memory run by replaying its persisted moves. */
function rebuildRun(p: PersistedRun): ActiveRun | null {
  try {
    const rng = new RNG(p.seed);
    let totalLoot = 0;
    for (let vi = 0; vi < p.vaults.length; vi++) {
      const sim = new Sim(rng, p.config, vi, p.boosters);
      for (const mv of p.vaults[vi].moves) sim.apply(mv);
      totalLoot += sim.loot;
      if (sim.state !== 'CRACKED') return null;
    }
    const vaultIndex = p.vaults.length;
    if (vaultIndex >= p.config.vaults.length) return null;
    const sim = new Sim(rng, p.config, vaultIndex, p.boosters);
    for (const mv of p.currentMoves) sim.apply(mv);
    if (sim.state !== 'PLAYING') return null;
    return { ...p, rng, vaultIndex, sim, totalLoot };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- boot

async function boot(): Promise<void> {
  show(loadingScreen());
  try {
    await preloadTiles();
    if (!api.hasSession()) {
      showWelcome();
      return;
    }
    try {
      state.profile = await api.profile();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) state.profile = await api.ensurePlayer();
      else throw e;
    }
    state.current = await api.currentEvent();
    showHome();
  } catch (e) {
    showError(e);
  }
}

function showError(e: unknown): void {
  const err = e instanceof ApiError ? e : null;
  const msg = err?.status === 0 ? `The game server is not reachable. Start the backend and make sure the client points at it.` : (err?.message ?? String(e));
  show(errorScreen('Connection lost', msg, err?.status === 0 ? `API: ${api ? (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8080' : ''}` : err ? `${err.status} ${err.code}` : '', () => void boot()));
}

function showWelcome(busy = false): void {
  show(
    welcomeScreen({
      defaultName: savedName() ?? '',
      busy,
      onStart: async (name) => {
        showWelcome(true);
        try {
          state.profile = await api.ensurePlayer(name);
          state.current = await api.currentEvent();
          sound.tap();
          showHome();
        } catch (e) {
          showError(e);
        }
      },
    }),
  );
}

// ---------------------------------------------------------------- home

async function refreshHome(): Promise<void> {
  try {
    const [profile, current] = await Promise.all([api.profile(), api.currentEvent()]);
    state.profile = profile;
    state.current = current;
    // Drop selected boosters the player no longer owns.
    for (const b of [...state.boosters]) if ((profile.boosters[b] ?? 0) <= 0) state.boosters.delete(b);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      state.profile = await api.ensurePlayer();
    } else throw e;
  }
}

function showHome(): void {
  if (!state.profile) return;
  const persisted = loadPersistedRun();
  const resumable = persisted ? { vault: persisted.vaults.length + 1, loot: persisted.totalLoot } : null;
  show(
    homeScreen({
      profile: state.profile,
      current: state.current,
      boosters: state.boosters,
      muted: sound.muted,
      starting: state.starting,
      resumable,
      onToggleBooster: (id) => {
        sound.tap();
        if (state.boosters.has(id)) state.boosters.delete(id);
        else state.boosters.add(id);
        showHome();
      },
      onStart: () => void startHeist(),
      onLeaderboard: () => void showLeaderboard('global'),
      onShop: () => void showShop(),
      onToggleSound: () => {
        sound.toggle();
        showHome();
      },
      onResume: () => {
        if (!persisted) return;
        const run = rebuildRun(persisted);
        if (!run) {
          toast('Saved heist could not be restored', 'error');
          localStorage.removeItem(RUN_KEY);
          showHome();
          return;
        }
        state.run = run;
        sound.tap();
        showPlay(false);
      },
      onDiscard: () => {
        overlayEl.replaceChildren(
          confirmModal('Abandon heist?', 'The loot from this run is lost. The life you spent is not refunded.', 'Abandon', () => {
            localStorage.removeItem(RUN_KEY);
            overlayEl.replaceChildren();
            showHome();
          }, () => overlayEl.replaceChildren()),
        );
      },
    }),
  );
}

async function goHome(): Promise<void> {
  show(loadingScreen('Regrouping…'));
  try {
    await refreshHome();
  } catch (e) {
    showError(e);
    return;
  }
  showHome();
}

// ---------------------------------------------------------------- heist

async function startHeist(): Promise<void> {
  if (state.starting) return;
  state.starting = true;
  showHome();
  sound.tap();
  try {
    const res = await api.startHeist([...state.boosters], uuid());
    const rng = new RNG(res.seed);
    const sim = new Sim(rng, res.config, 0, res.boosters);
    state.run = {
      runId: res.runId,
      seed: res.seed,
      config: res.config,
      boosters: res.boosters,
      eventName: state.current?.event.name ?? 'Global Heist',
      eventId: res.eventId,
      rng,
      vaultIndex: 0,
      sim,
      vaults: [],
      currentMoves: [],
      totalLoot: 0,
      startedAt: Date.now(),
      idemKey: uuid(),
      expiresAt: res.expiresAt,
    };
    state.boosters.clear();
    persistRun();
    showPlay(true);
  } catch (e) {
    const err = e instanceof ApiError ? e : null;
    if (err?.code === 'INSUFFICIENT_LIVES') toast('Out of lives — wait for a refill or buy one', 'error');
    else if (err?.code === 'INSUFFICIENT_BOOSTERS') toast('That booster is no longer in your inventory', 'error');
    else if (err?.code === 'EVENT_CLOSED') toast("Today's heist is closed. A new one starts at midnight UTC.", 'error');
    else toast(err?.message ?? 'Could not start the heist', 'error');
    try {
      await refreshHome();
    } catch {
      /* keep stale state */
    }
  } finally {
    state.starting = false;
    if (!state.run) showHome();
  }
}

let hud: PlayHud | null = null;

function currentObjectivesTarget(run: ActiveRun): Objectives {
  return scaledObjectives(run.config.vaults[run.vaultIndex].objectives, difficultyPct(run.config.difficulty));
}

function showPlay(animateIn: boolean): void {
  const run = state.run;
  if (!run) return;
  hud = playScreen({
    eventName: run.eventName,
    muted: sound.muted,
    onToggleSound: () => sound.toggle(),
    onQuit: () => {
      if (board?.animating) return;
      overlayEl.replaceChildren(
        confirmModal('Leave the heist?', 'Your progress is saved on this device. You can resume from the home screen until the run expires.', 'Leave for now', () => {
          overlayEl.replaceChildren();
          void goHome();
        }, () => overlayEl.replaceChildren()),
      );
    },
  });
  show(hud.root);
  board = new BoardView(hud.canvas, {
    onChain: (path, preview, tile) => {
      if (!hud) return;
      if (path.length >= 3) hud.setPreview(`+${fmt(preview)}${path.length >= 4 ? ` ×${(path.length >= 6 ? 3 : path.length === 5 ? 2 : 1.5).toString()}` : ''}`, TILE_STYLE[tile].top);
      else if (path.length > 0) hud.setPreview(`${path.length}/3`, 'rgba(255,255,255,.6)');
      else hud.setPreview(null, '');
    },
    onMove: (res, path) => onMove(res, path),
    onSettled: (res) => void onSettled(res),
  });
  board.setSim(run.sim, animateIn);
  board.showHint(run.vaults.length === 0 && run.currentMoves.length === 0);
  syncHud(run);
  hud.setHint(run.currentMoves.length === 0 && run.vaultIndex === 0 ? 'Drag through <b>3 or more</b> matching tiles. Disable the security systems to crack the vault.' : '');
}

function syncHud(run: ActiveRun): void {
  if (!hud) return;
  const cfg = run.config;
  hud.setVault(run.vaultIndex + 1, cfg.vaults.length, cfg.vaultMultipliers[run.vaultIndex], cfg.vaults[run.vaultIndex].name);
  hud.setMoves(run.sim.movesLeft);
  hud.setObjectives(run.sim.objectives, currentObjectivesTarget(run));
  hud.setLoot(run.totalLoot + run.sim.loot);
  hud.setLadder(run.vaultIndex, cfg.vaultMultipliers);
}

function onMove(res: MoveResult, path: number[]): void {
  const run = state.run;
  if (!run || !hud) return;
  run.currentMoves.push(path);
  persistRun();
  hud.setMoves(run.sim.movesLeft, true);
  hud.setObjectives(res.objectives, currentObjectivesTarget(run));
  hud.setLoot(run.totalLoot + run.sim.loot);
  hud.setPreview(null, '');
  if (run.currentMoves.length === 1 && run.vaultIndex === 0) hud.setHint('Longer chains multiply loot: <b>4 = ×1.5</b>, <b>5 = ×2</b>, <b>6+ = ×3</b>.');
  else if (run.currentMoves.length === 3 && run.vaultIndex === 0) hud.setHint('Chain <b>guards</b> for a bonus move. Clear tiles next to a <b>lock</b> to open it.');
  else if (run.currentMoves.length > 3) hud.setHint('');
}

async function onSettled(res: MoveResult): Promise<void> {
  const run = state.run;
  if (!run || !board) return;
  if (res.state === 'PLAYING') return;

  run.vaults.push({ moves: run.currentMoves });
  run.currentMoves = [];
  run.totalLoot += run.sim.loot;
  persistRun();
  const cfg = run.config;
  const reached = run.vaults.length;

  if (res.state === 'CRACKED') {
    sound.crack();
    board.celebrate();
    board.flash('#F7C948', 0.3);
    const isLast = run.vaultIndex >= cfg.vaults.length - 1;
    await banner('cracked', 'VAULT CRACKED', isLast ? 'The whole museum is yours.' : `${fmt(run.totalLoot)} loot · ${multStr(cfg.vaultMultipliers[run.vaultIndex])} if you escape now`, isLast ? 1600 : 1300);
    if (isLast) {
      await finishRun(true);
      return;
    }
    const nextIdx = run.vaultIndex + 1;
    overlayEl.replaceChildren(
      decisionModal({
        vault: reached,
        total: cfg.vaults.length,
        loot: run.totalLoot,
        currentMult: cfg.vaultMultipliers[run.vaultIndex],
        nextMult: cfg.vaultMultipliers[nextIdx],
        escapeScore: escapeScore(cfg, run.totalLoot, reached),
        deeperScore: escapeScore(cfg, run.totalLoot, reached + 1),
        bustScore: bustScore(cfg, run.totalLoot, reached + 1, run.boosters),
        nextVault: cfg.vaults[nextIdx],
        nextObjectives: scaledObjectives(cfg.vaults[nextIdx].objectives, difficultyPct(cfg.difficulty)),
        onEscape: () => {
          sound.tap();
          overlayEl.replaceChildren();
          void finishRun(true);
        },
        onDeeper: () => {
          sound.whoosh();
          overlayEl.replaceChildren();
          goDeeper();
        },
      }),
    );
    return;
  }

  // BUSTED
  sound.bust();
  board.shake(10);
  board.flash('#FF4D6D', 0.45);
  await banner('busted', 'BUSTED', reached >= 2 ? `You keep ${100 - Math.round(cfg.bustPenalty * (run.boosters.includes('shield') ? 50 : 100))}% of your loot at ${multStr(cfg.vaultMultipliers[reached - 2])}` : 'The guards got you in the first vault.', 1500);
  await finishRun(false);
}

function goDeeper(): void {
  const run = state.run;
  if (!run || !board) return;
  run.vaultIndex++;
  run.sim = new Sim(run.rng, run.config, run.vaultIndex, run.boosters);
  persistRun();
  board.setSim(run.sim, true);
  board.showHint(false);
  syncHud(run);
  hud?.setHint('');
}

interface ResultState {
  run: ActiveRun;
  local: ReturnType<typeof runReplay>;
  response: FinishResponse | null;
  error: string | null;
  submitting: boolean;
  claimed: boolean;
  claiming: boolean;
  rank: LBEntry | null;
  total: number;
}

let result: ResultState | null = null;

async function finishRun(escaped: boolean): Promise<void> {
  const run = state.run;
  if (!run) return;
  const replay = { vaults: run.vaults, escaped, clientScore: 0, durationMs: Math.max(1, Date.now() - run.startedAt) };
  let local: ReturnType<typeof runReplay>;
  try {
    local = runReplay(run.config, run.seed, run.boosters, replay);
  } catch (e) {
    toast('Local replay failed: ' + String(e), 'error');
    localStorage.removeItem(RUN_KEY);
    state.run = null;
    void goHome();
    return;
  }
  replay.clientScore = local.score;
  result = { run, local, response: null, error: null, submitting: true, claimed: false, claiming: false, rank: null, total: 0 };
  renderResult();
  try {
    const res = await api.finishHeist(run.runId, replay, run.idemKey);
    result.response = res;
    state.profile = res.profile;
    localStorage.removeItem(RUN_KEY);
    state.run = null;
    if (res.score !== local.score) toast(`Server scored ${fmt(res.score)} (client ${fmt(local.score)})`, 'error');
    result.submitting = false;
    renderResult();
    // Rank is eventually consistent (async leaderboard sink); poll briefly.
    for (let i = 0; i < 6 && result && result.response === res; i++) {
      try {
        const lb = await api.leaderboard(run.eventId, 1);
        if (lb.me && lb.me.score >= res.score) {
          result.rank = lb.me;
          result.total = lb.total;
          renderResult();
          break;
        }
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (e) {
    const err = e instanceof ApiError ? e : null;
    if (err && (err.code === 'RUN_ALREADY_FINISHED' || err.code === 'RUN_EXPIRED' || err.code === 'RUN_NOT_FOUND')) {
      // Nothing more we can do with this run; the idempotent replay path covers the happy case.
      localStorage.removeItem(RUN_KEY);
      state.run = null;
    }
    result.error = err ? `${err.message} (${err.code})` : String(e);
    result.submitting = false;
    renderResult();
  }
}

function renderResult(): void {
  const r = result;
  if (!r) return;
  const cfg = r.run.config;
  const res = r.response;
  const shield = r.run.boosters.includes('shield');
  const canPlayAgain = !!state.profile && state.profile.lives >= cfg.livesCost && state.current?.event.status === 'ACTIVE';
  show(
    resultScreen({
      eventName: r.run.eventName,
      outcome: res?.outcome ?? r.local.outcome,
      score: res?.score ?? r.local.score,
      loot: res?.loot ?? r.local.loot,
      multiplier: res?.multiplier ?? r.local.multiplier,
      vaultReached: res?.vaultReached ?? r.local.vaultReached,
      vaultsCracked: res?.vaultsCracked ?? r.local.vaultsCracked,
      totalVaults: cfg.vaults.length,
      penalty: cfg.bustPenalty * (shield ? 0.5 : 1),
      shield,
      reward: res?.reward ?? null,
      claimed: r.claimed,
      claiming: r.claiming,
      rank: r.rank,
      total: r.total,
      submitting: r.submitting,
      error: r.error,
      canPlayAgain,
      onClaim: () => void claimReward(res?.reward ?? null),
      onHome: () => void goHome(),
      onLeaderboard: () => void showLeaderboard('rivals', () => renderResult()),
      onPlayAgain: () => {
        sound.tap();
        void (async () => {
          try {
            await refreshHome();
          } catch {
            /* ignore */
          }
          void startHeist();
        })();
      },
      onRetry: () => {
        if (!result) return;
        result.submitting = true;
        result.error = null;
        renderResult();
        void (async () => {
          try {
            const rep = { vaults: r.run.vaults, escaped: r.local.outcome === 'ESCAPED', clientScore: r.local.score, durationMs: Math.max(1, Date.now() - r.run.startedAt) };
            const resp = await api.finishHeist(r.run.runId, rep, r.run.idemKey);
            if (result) {
              result.response = resp;
              result.submitting = false;
              state.profile = resp.profile;
              localStorage.removeItem(RUN_KEY);
              state.run = null;
              renderResult();
            }
          } catch (e) {
            if (result) {
              result.error = e instanceof ApiError ? `${e.message} (${e.code})` : String(e);
              result.submitting = false;
              renderResult();
            }
          }
        })();
      },
    }),
  );
}

async function claimReward(reward: Reward | null): Promise<void> {
  if (!reward || !result || result.claiming || result.claimed) return;
  result.claiming = true;
  renderResult();
  try {
    const res = await api.claim(reward.rewardId, `claim-${reward.rewardId}`);
    state.profile = res.profile;
    result.claimed = true;
    sound.coin();
    toast(`+${fmt(reward.coins)} coins added`, 'success');
  } catch (e) {
    const err = e instanceof ApiError ? e : null;
    if (err?.code === 'REWARD_ALREADY_CLAIMED') {
      result.claimed = true;
      toast('Already claimed — no double payouts here', 'info');
    } else toast(err?.message ?? 'Claim failed', 'error');
  } finally {
    if (result) {
      result.claiming = false;
      renderResult();
    }
  }
}

// ---------------------------------------------------------------- leaderboard / shop

let lbTab: 'global' | 'rivals' = 'global';

async function showLeaderboard(tab: 'global' | 'rivals', onBack: () => void = () => void goHome()): Promise<void> {
  lbTab = tab;
  const eventId = state.current?.event.eventId;
  const eventName = state.current?.event.name ?? 'Global Heist';
  const endsAt = state.current?.event.endsAt ?? null;
  const myId = state.profile?.playerId ?? '';
  const render = (b: Board | null, loading: boolean) =>
    show(
      leaderboardScreen({
        eventName,
        endsAt,
        tab: lbTab,
        board: b,
        myId,
        loading,
        onBack,
        onTab: (t) => {
          sound.tap();
          void showLeaderboard(t, onBack);
        },
      }),
    );
  render(null, true);
  try {
    const b = tab === 'global' ? await api.leaderboard(eventId, 100) : await api.rivals(eventId);
    if (lbTab === tab) render(b, false);
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'Leaderboard unavailable', 'error');
    render(null, false);
  }
}

let catalog: ShopItem[] | null = null;
let buying: string | null = null;

async function showShop(): Promise<void> {
  if (!state.profile) return;
  if (!catalog) {
    try {
      catalog = (await api.catalog()).items;
    } catch (e) {
      toast('Shop unavailable', 'error');
      return;
    }
  }
  const render = () =>
    show(
      shopScreen({
        items: catalog ?? [],
        profile: state.profile!,
        buying,
        onBack: () => void goHome(),
        onBuy: async (id) => {
          if (buying) return;
          buying = id;
          render();
          try {
            const res = await api.purchase(id, uuid());
            state.profile = res.profile;
            sound.coin();
            toast('Purchased', 'success');
          } catch (e) {
            const err = e instanceof ApiError ? e : null;
            toast(err?.code === 'INSUFFICIENT_COINS' ? 'Not enough coins' : (err?.message ?? 'Purchase failed'), 'error');
            if (err?.code === 'VERSION_CONFLICT') {
              try {
                state.profile = await api.profile();
              } catch {
                /* ignore */
              }
            }
          } finally {
            buying = null;
            render();
          }
        },
      }),
    );
  render();
}

// ---------------------------------------------------------------- go

if (import.meta.env.DEV) {
  // Dev hook for automated screenshots / smoke scripts (never shipped in prod builds).
  (window as unknown as { __vr: unknown }).__vr = { state, board: () => board };
}

void boot();
