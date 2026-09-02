// Profile hot path: GET /v1/player/profile.
//
// A single-item DynamoDB GetItem behind bearer-token auth — the cheapest authenticated
// request in the API, which makes it the baseline for per-request overhead (auth,
// rate limiter, JSON encoding, middleware).
//
//   k6 run -e BASE_URL=http://localhost:8080 -e VUS=200 -e DURATION=60s profile.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { config, createPlayer, jsonHeaders, summaryTrendStats } from './lib/common.js';
import { makeSummary } from './lib/summary.js';

const profileDuration = new Trend('profile_duration', true);

export const options = {
  scenarios: {
    readers: {
      executor: 'constant-vus',
      vus: config.vus,
      duration: config.duration,
      gracefulStop: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200'],
    profile_duration: ['p(95)<200'],
  },
  summaryTrendStats,
  tags: { script: 'profile' },
};

let session = null;

export default function () {
  if (!session) {
    session = createPlayer();
  }

  const res = http.get(`${config.baseUrl}/v1/player/profile`, {
    headers: jsonHeaders(session.token),
    tags: { name: 'GET /v1/player/profile' },
  });
  profileDuration.add(res.timings.duration);
  check(res, {
    'profile 200': (r) => r.status === 200,
    'profile is mine': (r) => r.status === 200 && r.json('playerId') === session.playerId,
    'profile has version': (r) => r.status === 200 && typeof r.json('version') === 'number',
  });

  sleep(config.sleep);
}

export function handleSummary(data) {
  return makeSummary(data, {
    script: 'profile',
    endpoints: [['GET /v1/player/profile', 'profile_duration']],
  });
}
