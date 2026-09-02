// Shared helpers for the Vault Rush k6 scripts.
//
// Environment:
//   BASE_URL     API base URL                         default http://localhost:8080
//   VUS          virtual users                        default 10
//   DURATION     test duration (k6 syntax)            default 30s
//   SLEEP        seconds between iterations per VU    default 1.5
//   RESULTS_DIR  where <script>-summary.json goes     default ../results (relative to cwd)
//
// Rate limiting: the API allows 100 requests / minute / player. A VU is one player, so
// keep (requests per iteration) / SLEEP below ~1.6 req/s, or start the API with a higher
// RATE_LIMIT_PER_MIN when the goal is to saturate the server rather than a player.

import http from 'k6/http';
import { check, fail, sleep } from 'k6';

export const config = {
  baseUrl: (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  vus: parseInt(__ENV.VUS || '10', 10),
  duration: __ENV.DURATION || '30s',
  sleep: parseFloat(__ENV.SLEEP || '1.5'),
  resultsDir: (__ENV.RESULTS_DIR || '../results').replace(/\/+$/, ''),
};

// Percentiles reported in the end-of-test summary (and available to handleSummary).
export const summaryTrendStats = ['avg', 'min', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'];

export function jsonHeaders(token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// Unique per VU, iteration and run so repeated runs never resume a previous player
// (POST /v1/player is idempotent per deviceId).
export function randomDeviceId(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix || 'k6'}-${__VU}-${__ITER}-${Date.now().toString(36)}-${rand}`;
}

// Creates a player and returns { token, playerId }. Aborts the iteration on failure.
export function createPlayer(displayName) {
  const res = http.post(
    `${config.baseUrl}/v1/player`,
    JSON.stringify({
      deviceId: randomDeviceId('k6'),
      displayName: displayName || `k6-vu-${__VU}`,
    }),
    { headers: jsonHeaders(), tags: { name: 'POST /v1/player' } },
  );

  // status 0 = transport error (no body): guard before calling res.json().
  const created = res.status === 200 || res.status === 201;
  const ok = check(res, {
    'POST /v1/player -> 200/201': () => created,
    'POST /v1/player returns token': (r) => created && !!r.json('token'),
  });

  if (!ok) {
    // Back off before aborting the iteration so a dead or overloaded target is not
    // hammered in a tight loop by every VU.
    sleep(config.sleep);
    fail(`player creation failed: HTTP ${res.status} ${String(res.body || '').slice(0, 200)}`);
  }

  return { token: res.json('token'), playerId: res.json('playerId') };
}
