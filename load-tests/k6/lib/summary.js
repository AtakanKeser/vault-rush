// handleSummary helper: writes the raw k6 summary as JSON to RESULTS_DIR and prints a
// compact text report (p50/p95/p99, error rate, per-endpoint latency, thresholds).

import { config } from './common.js';

function num(value, digits) {
  if (typeof value !== 'number' || !isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(digits === undefined ? 2 : digits);
}

function pct(rate) {
  return `${num((rate || 0) * 100, 2)}%`;
}

function p(values, key) {
  if (!values) {
    return undefined;
  }
  if (key === 'p(50)' && values['p(50)'] === undefined) {
    return values.med;
  }
  return values[key];
}

function pad(text, width) {
  return String(text).padStart(width);
}

function trendLine(label, metric) {
  if (!metric || !metric.values) {
    return `    ${label.padEnd(32)} (no samples)`;
  }
  const v = metric.values;
  return (
    `    ${label.padEnd(32)}` +
    ` p50 ${pad(num(p(v, 'p(50)')), 9)}` +
    ` p95 ${pad(num(p(v, 'p(95)')), 9)}` +
    ` p99 ${pad(num(p(v, 'p(99)')), 9)}` +
    ` max ${pad(num(v.max), 9)}`
  );
}

// opts.script     name used for the JSON file (<script>-summary.json)
// opts.endpoints  [[label, trendMetricName], ...] printed per endpoint
// opts.vus        override for the reported VU count (scripts with fixed options)
// opts.duration   override for the reported duration
export function makeSummary(data, opts) {
  const vus = opts.vus !== undefined ? opts.vus : config.vus;
  const duration = opts.duration !== undefined ? opts.duration : config.duration;
  const m = data.metrics || {};
  const reqs = (m.http_reqs && m.http_reqs.values) || {};
  const failed = (m.http_req_failed && m.http_req_failed.values) || {};
  const dur = (m.http_req_duration && m.http_req_duration.values) || {};
  const checks = m.checks && m.checks.values;

  // For a Rate metric, `passes` counts samples equal to true: for http_req_failed that is
  // the number of failed requests.
  const failedCount = failed.passes || 0;
  const totalCount = failedCount + (failed.fails || 0);

  const lines = [];
  lines.push('');
  lines.push(`Vault Rush load test - ${opts.script}`);
  lines.push(`  base_url    ${config.baseUrl}`);
  lines.push(`  vus         ${vus}    duration ${duration}    sleep ${config.sleep}s`);
  lines.push(`  requests    ${reqs.count || 0}    throughput ${num(reqs.rate)} req/s`);
  lines.push(`  error rate  ${pct(failed.rate)} (${failedCount} failed / ${totalCount})`);
  lines.push(
    `  latency ms  p50 ${num(p(dur, 'p(50)'))}   p95 ${num(p(dur, 'p(95)'))}` +
      `   p99 ${num(p(dur, 'p(99)'))}   max ${num(dur.max)}`,
  );

  if (opts.endpoints && opts.endpoints.length > 0) {
    lines.push('  per endpoint (ms):');
    for (const pair of opts.endpoints) {
      lines.push(trendLine(pair[0], m[pair[1]]));
    }
  }

  if (checks) {
    lines.push(`  checks      ${pct(checks.rate)} passed (${checks.passes}/${checks.passes + checks.fails})`);
  }

  lines.push('  thresholds:');
  let anyThreshold = false;
  for (const name of Object.keys(m)) {
    const thresholds = m[name].thresholds;
    if (!thresholds) {
      continue;
    }
    for (const expr of Object.keys(thresholds)) {
      anyThreshold = true;
      lines.push(`    ${thresholds[expr].ok ? 'PASS' : 'FAIL'}  ${name}: ${expr}`);
    }
  }
  if (!anyThreshold) {
    lines.push('    (none)');
  }
  lines.push('');

  const out = {};
  out.stdout = `${lines.join('\n')}\n`;
  out[`${config.resultsDir}/${opts.script}-summary.json`] = JSON.stringify(data, null, 2);
  return out;
}
