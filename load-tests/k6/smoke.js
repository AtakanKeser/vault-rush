// Smoke test: one VU, one iteration, every read endpoint a fresh client touches.
// Run it before any load test to make sure the target is the right API in the right state.
//
//   k6 run -e BASE_URL=http://localhost:8080 smoke.js

import http from 'k6/http';
import { check } from 'k6';
import { config, createPlayer, jsonHeaders, summaryTrendStats } from './lib/common.js';
import { makeSummary } from './lib/summary.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
  summaryTrendStats,
  tags: { script: 'smoke' },
};

export default function () {
  const health = http.get(`${config.baseUrl}/healthz`, { tags: { name: 'GET /healthz' } });
  check(health, {
    'healthz 200': (r) => r.status === 200,
    'healthz status ok': (r) => r.status === 200 && r.json('status') === 'ok',
  });

  // 503 here means a dependency is degraded — still worth knowing before a load test.
  const ready = http.get(`${config.baseUrl}/readyz`, { tags: { name: 'GET /readyz' } });
  check(ready, {
    'readyz 200': (r) => r.status === 200,
    'readyz deps ok': (r) =>
      r.status === 200 &&
      r.json('deps.redis') === 'ok' &&
      r.json('deps.dynamodb') === 'ok' &&
      r.json('deps.queue') === 'ok',
  });

  const session = createPlayer('k6-smoke');
  const headers = jsonHeaders(session.token);

  const profile = http.get(`${config.baseUrl}/v1/player/profile`, {
    headers,
    tags: { name: 'GET /v1/player/profile' },
  });
  check(profile, {
    'profile 200': (r) => r.status === 200,
    'profile playerId matches': (r) => r.status === 200 && r.json('playerId') === session.playerId,
    'profile has lives': (r) => r.status === 200 && typeof r.json('lives') === 'number',
  });

  const events = http.get(`${config.baseUrl}/v1/events/current`, {
    headers,
    tags: { name: 'GET /v1/events/current' },
  });
  check(events, {
    'events 200': (r) => r.status === 200,
    'event is ACTIVE': (r) => r.status === 200 && r.json('event.status') === 'ACTIVE',
    'event config has vaults': (r) => {
      if (r.status !== 200) {
        return false;
      }
      const vaults = r.json('config.vaults');
      return Array.isArray(vaults) && vaults.length > 0;
    },
  });

  const leaderboard = http.get(`${config.baseUrl}/v1/leaderboard/global?limit=10`, {
    headers,
    tags: { name: 'GET /v1/leaderboard/global' },
  });
  check(leaderboard, {
    'leaderboard 200': (r) => r.status === 200,
    'leaderboard entries is array': (r) => r.status === 200 && Array.isArray(r.json('entries')),
  });

  const rewards = http.get(`${config.baseUrl}/v1/rewards`, { headers, tags: { name: 'GET /v1/rewards' } });
  check(rewards, { 'rewards 200': (r) => r.status === 200 });

  const catalog = http.get(`${config.baseUrl}/v1/shop/catalog`, {
    headers,
    tags: { name: 'GET /v1/shop/catalog' },
  });
  check(catalog, {
    'catalog 200': (r) => r.status === 200,
    'catalog has items': (r) => r.status === 200 && Array.isArray(r.json('items')),
  });
}

export function handleSummary(data) {
  return makeSummary(data, { script: 'smoke', vus: 1, duration: '1 iteration' });
}
