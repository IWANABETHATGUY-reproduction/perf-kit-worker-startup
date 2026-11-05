// Scores built app copies by Worker startup: the active CPU ms in the profile of
// `wrangler check startup`, with a sampling interval of 100 µs.
// It bundles each copy once, waits for an idle machine, then runs alternating passes.
// A copy's score is the median of its pass medians.
// Usage: node harness/score.mjs [--runs 7] [--passes 3] [--interval-us 100] [--json <file>] <label>=<workerDir>...
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { option, WORK_ROOT, workerConfig, WRANGLER } from './lib.mjs';

const ENV = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function bundle(label, workerDir, tmp) {
  const config = workerConfig(workerDir);
  const c = JSON.parse(fs.readFileSync(config, 'utf8'));
  // Newer wrangler rejects a field that older plugins write; container images need Docker
  // and do not change the global scope.
  delete c.legacy_env;
  delete c.containers;
  const startupConfig = config.replace(/wrangler\.json$/, 'wrangler.startup.json');
  fs.writeFileSync(startupConfig, JSON.stringify(c));
  const out = path.join(tmp, label);
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'worker.bundle');
  execFileSync(WRANGLER, ['deploy', '--dry-run', '--outfile', file, '-c', startupConfig], {
    cwd: workerDir,
    env: ENV,
    stdio: 'pipe',
  });
  return { file, out, kib: fs.statSync(file).size / 1024 };
}

// wrangler keeps V8's default sampling interval (about 1.5 ms), too coarse for a startup of a
// few ms. This copy of wrangler's CLI sets the interval before it starts the profiler.
const PATCH = (intervalUs) => [
  ['async function sendInspectorCommand(ws, id, method, signal) {', 'async function sendInspectorCommand(ws, id, method, signal, params = {}) {'],
  ['ws.send(JSON.stringify({ id, method, params: {} }), (error64) => {', 'ws.send(JSON.stringify({ id, method, params }), (error64) => {'],
  [
    '    await sendInspectorCommand(ws, 2, "Profiler.start", abortController.signal);',
    `    await sendInspectorCommand(ws, 4, "Profiler.setSamplingInterval", abortController.signal, { interval: ${intervalUs} });\n    await sendInspectorCommand(ws, 2, "Profiler.start", abortController.signal);`,
  ],
];

// Next to the original, so that the CLI's relative paths still resolve.
function samplingCli(intervalUs) {
  const dist = path.join(path.dirname(fs.realpathSync(WRANGLER)), '../wrangler-dist');
  let text = fs.readFileSync(path.join(dist, 'cli.js'), 'utf8');
  for (const [from, to] of PATCH(intervalUs)) {
    if (text.split(from).length !== 2) throw new Error(`the wrangler CLI changed: expected one "${from}"`);
    text = text.replace(from, () => to);
  }
  const file = path.join(dist, `cli.sampling-${intervalUs}us.js`);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  return file;
}

// Active CPU in the profile. Like wrangler's "Active", each sample that is not "(idle)" counts
// the time since the sample before it, but at most three intervals: most profiles have no
// sample for 6 to 7 ms after the first, idle sample, a few also later, and wrangler charges
// each gap to the next sample.
function activeMs(cli, b, workerDir, run, intervalUs) {
  const file = path.join(b.out, `run-${run}.cpuprofile`);
  execFileSync(process.execPath, ['--no-warnings', cli, 'check', 'startup', '--worker', b.file, '--outfile', file], {
    cwd: workerDir,
    env: ENV,
    stdio: 'pipe',
  });
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  const idle = new Set(profile.nodes.filter((n) => n.callFrame.functionName === '(idle)').map((n) => n.id));
  let us = 0;
  profile.samples.forEach((id, i) => {
    if (!idle.has(id)) us += Math.min(profile.timeDeltas[i], 3 * intervalUs);
  });
  return Math.round(us / 100) / 10;
}

async function waitForIdle(maxLoad) {
  for (;;) {
    const [, five] = os.loadavg();
    if (five < maxLoad) return os.loadavg();
    console.log(`waiting: 5-minute load ${five.toFixed(2)} >= ${maxLoad}`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
}

export async function score(copies, { runs = 7, passes = 3, intervalUs = 100, maxLoad = 4 } = {}) {
  const cli = samplingCli(intervalUs);
  const tmp = fs.mkdtempSync(path.join(WORK_ROOT, 'score-tmp-'));
  const bundles = new Map();
  for (const [label, dir] of copies) bundles.set(label, bundle(label, dir, tmp));
  const load = await waitForIdle(maxLoad);
  console.log(`idle: ${load.map((l) => l.toFixed(2)).join(' ')}`);
  const results = new Map(copies.map(([label]) => [label, []]));
  for (let p = 1; p <= passes; p++) {
    for (const [label, dir] of copies) {
      const b = bundles.get(label);
      const actives = [];
      for (let i = 1; i <= runs; i++) actives.push(activeMs(cli, b, dir, `${p}-${i}`, intervalUs));
      results.get(label).push({ median: median(actives), runs: actives });
      console.log(
        `pass ${p} ${label.padEnd(16)} ${median(actives).toFixed(1).padStart(7)} ms   runs: ${[...actives].sort((a, b) => a - b).join(' ')}`,
      );
    }
  }
  const summary = copies.map(([label, dir]) => ({
    label,
    dir,
    ms: median(results.get(label).map((r) => r.median)),
    bundleKiB: Math.round(bundles.get(label).kib),
    passes: results.get(label),
  }));
  console.log(`load at end: ${os.loadavg().map((l) => l.toFixed(2)).join(' ')}`);
  for (const s of summary) {
    console.log(`SCORE ${s.label} ${s.ms.toFixed(1)} ms (bundle ${s.bundleKiB} KiB)`);
  }
  return { at: new Date().toISOString(), runs, passes, intervalUs, summary, profiles: tmp };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const runs = Number(option(args, '--runs', '7'));
  const passes = Number(option(args, '--passes', '3'));
  const intervalUs = Number(option(args, '--interval-us', '100'));
  const json = option(args, '--json');
  const copies = args.map((a) => {
    const i = a.indexOf('=');
    if (i < 1) throw new Error(`expected <label>=<workerDir>, got "${a}"`);
    return [a.slice(0, i), path.resolve(a.slice(i + 1))];
  });
  if (copies.length === 0) {
    console.error('usage: node harness/score.mjs [--runs 7] [--passes 3] [--interval-us 100] [--json <file>] <label>=<workerDir>...');
    process.exit(2);
  }
  const result = await score(copies, { runs, passes, intervalUs });
  if (json) fs.writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`);
}
