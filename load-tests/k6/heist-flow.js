// Heist flow — the real thing.
//
// Every iteration is one complete player journey, exactly as the client does it:
//   1. POST /v1/player            (fresh device; each start costs a life)
//   2. POST /v1/heists/start      -> seed + pinned config
//   3. play locally with the deterministic engine (lib/engine.js + lib/bot.js)
//   4. POST /v1/heists/{runId}/finish with Idempotency-Key — the server replays
//      the whole run and must reproduce the bot's score exactly
//   5. the same finish request again -> Idempotent-Replayed: true, same body
//   6. POST /v1/rewards/claim
//
// This is the heaviest write path in the game (replay + conditional writes +
// telemetry fan-out), so `heist_finish_duration` is the number to watch.
//
//   k6 run -e BASE_URL=http://localhost:8080 -e VUS=100 -e DURATION=60s heist-flow.js
//   k6 run -e BASE_URL=http://localhost:8080 -e VUS=50 -e ITERATIONS=5 heist-flow.js   # fixed work

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { config, createPlayer, jsonHeaders, summaryTrendStats } from './lib/common.js';
import { makeSummary } from './lib/summary.js';
import { playRun } from './lib/bot.js';

const startDuration = new Trend('heist_start_duration', true);
const finishDuration = new Trend('heist_finish_duration', true);
const claimDuration = new Trend('reward_claim_duration', true);
const scoreMismatch = new Counter('score_mismatch');
const movesPlayed = new Counter('moves_played');

const iterations = parseInt(__ENV.ITERATIONS || '0', 10);

export const options = {
  scenarios: iterations > 0
    ? {
        heists: {
          executor: 'per-vu-iterations',
          vus: config.vus,
          iterations,
          maxDuration: config.duration,
          gracefulStop: '15s',
        },
      }
    : {
        heists: {
          executor: 'constant-vus',
          vus: config.vus,
          duration: config.duration,
          gracefulStop: '15s',
        },
      },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    heist_start_duration: ['p(95)<300'],
    heist_finish_duration: ['p(95)<300'],
    score_mismatch: ['count==0'],
  },
  summaryTrendStats,
  tags: { script: 'heist-flow' },
};

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function () {
  const session = createPlayer('k6-heist');
  const headers = jsonHeaders(session.token);

  // Player archetype: 1/3 cautious (escape after vault 1-2), 1/3 balanced, 1/3 reckless.
  const roll = Math.random();
  const opts = roll < 0.33 ? { maxVault: 1 + Math.floor(Math.random() * 2), maxChain: 5 } : roll < 0.66 ? { maxVault: 3 + Math.floor(Math.random() * 2), maxChain: 6 } : { maxVault: 5, maxChain: 6, greedy: true };
  const boosters = Math.random() < 0.25 ? ['extra_moves'] : [];

  const start = http.post(`${config.baseUrl}/v1/heists/start`, JSON.stringify({ boosters }), {
    headers: Object.assign({ 'Idempotency-Key': uuid() }, headers),
    tags: { name: 'POST /v1/heists/start' },
  });
  startDuration.add(start.timings.duration);
  const started = check(start, {
    'start 201': (r) => r.status === 201,
    'start has seed+config': (r) => r.status === 201 && typeof r.json('seed') === 'number' && Array.isArray(r.json('config.vaults')),
  });
  if (!started) {
    sleep(config.sleep);
    return;
  }
  const run = start.json();

  // Play locally — this is CPU work in the VU, like on a phone.
  const { replay, result } = playRun(run.config, run.seed, run.boosters, opts);
  movesPlayed.add(replay.vaults.reduce((n, v) => n + v.moves.length, 0));

  const idem = uuid();
  const finishHeaders = Object.assign({ 'Idempotency-Key': idem }, headers);
  const finish = http.post(`${config.baseUrl}/v1/heists/${run.runId}/finish`, JSON.stringify(replay), {
    headers: finishHeaders,
    tags: { name: 'POST /v1/heists/{runId}/finish' },
  });
  finishDuration.add(finish.timings.duration);
  const finished = check(finish, {
    'finish 200': (r) => r.status === 200,
    'server outcome == bot outcome': (r) => r.status === 200 && r.json('outcome') === result.outcome,
    'server score == bot score': (r) => r.status === 200 && r.json('score') === result.score,
  });
  if (finish.status === 200 && finish.json('score') !== result.score) scoreMismatch.add(1);
  if (!finished) {
    sleep(config.sleep);
    return;
  }

  // Retry after a "lost response": must be answered from the idempotency store.
  const again = http.post(`${config.baseUrl}/v1/heists/${run.runId}/finish`, JSON.stringify(replay), {
    headers: finishHeaders,
    tags: { name: 'POST /v1/heists/{runId}/finish (replay)' },
  });
  check(again, {
    'idempotent replay 200': (r) => r.status === 200,
    'idempotent replay header': (r) => r.headers['Idempotent-Replayed'] === 'true',
    'idempotent replay identical body': (r) => r.body === finish.body,
  });

  const rewardId = finish.json('reward.rewardId');
  if (rewardId) {
    const claim = http.post(`${config.baseUrl}/v1/rewards/claim`, JSON.stringify({ rewardId }), {
      headers: Object.assign({ 'Idempotency-Key': uuid() }, headers),
      tags: { name: 'POST /v1/rewards/claim' },
    });
    claimDuration.add(claim.timings.duration);
    check(claim, { 'claim 200': (r) => r.status === 200 });
  }

  sleep(config.sleep);
}

export function handleSummary(data) {
  return makeSummary(data, {
    script: 'heist-flow',
    endpoints: [
      ['POST /v1/heists/start', 'heist_start_duration'],
      ['POST /v1/heists/{runId}/finish', 'heist_finish_duration'],
      ['POST /v1/rewards/claim', 'reward_claim_duration'],
    ],
  });
}
