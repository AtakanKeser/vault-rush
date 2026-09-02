// Leaderboard read path.
//
// Each VU creates one player, then loops: GET /v1/leaderboard/global, GET /v1/events/current.
// Both endpoints are served from Redis (sorted set + cached config) and are the hottest
// reads in the game: every client polls them on the home screen.
//
//   k6 run -e BASE_URL=http://localhost:8080 -e VUS=200 -e DURATION=60s leaderboard.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { config, createPlayer, jsonHeaders, summaryTrendStats } from './lib/common.js';
import { makeSummary } from './lib/summary.js';

const leaderboardDuration = new Trend('leaderboard_duration', true);
const eventsDuration = new Trend('events_duration', true);

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
    leaderboard_duration: ['p(95)<200'],
    events_duration: ['p(95)<200'],
  },
  summaryTrendStats,
  tags: { script: 'leaderboard' },
};

// Each VU runs in its own JS runtime, so this module-level variable holds exactly one
// player per VU for the lifetime of the test.
let session = null;

export default function () {
  if (!session) {
    session = createPlayer();
  }
  const headers = jsonHeaders(session.token);

  const lb = http.get(`${config.baseUrl}/v1/leaderboard/global?limit=100`, {
    headers,
    tags: { name: 'GET /v1/leaderboard/global' },
  });
  leaderboardDuration.add(lb.timings.duration);
  check(lb, {
    'leaderboard 200': (r) => r.status === 200,
    'leaderboard has entries': (r) => r.status === 200 && Array.isArray(r.json('entries')),
  });

  const ev = http.get(`${config.baseUrl}/v1/events/current`, {
    headers,
    tags: { name: 'GET /v1/events/current' },
  });
  eventsDuration.add(ev.timings.duration);
  check(ev, {
    'events 200': (r) => r.status === 200,
    'events has eventId': (r) => r.status === 200 && !!r.json('event.eventId'),
  });

  sleep(config.sleep);
}

export function handleSummary(data) {
  return makeSummary(data, {
    script: 'leaderboard',
    endpoints: [
      ['GET /v1/leaderboard/global', 'leaderboard_duration'],
      ['GET /v1/events/current', 'events_duration'],
    ],
  });
}
