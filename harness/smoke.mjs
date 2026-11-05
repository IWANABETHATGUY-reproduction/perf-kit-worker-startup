// Starts each built copy of an app with `wrangler dev`, requests the app's smoke paths
// (`smoke` in apps.json) and prints the status and the start of each answer. Then it lists
// the paths where a copy answers differently from the first copy. Use it for an app without
// tests, and for a change that can break a route at runtime.
// The run is local: no containers, no remote-only bindings, fresh state for each copy. It runs
// the app's own code. A path is `<path>` or `<path>|<accept header>`. A body that does not end
// (SSE) is read for 3 s.
// Usage: node harness/smoke.mjs [--port 8790] <app> <label>...
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, option, WORK_ROOT, workerConfig, WRANGLER } from './lib.mjs';

const ENV = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
const BODY_CHARS = 90;
const READ_MS = 3000;
const READY_MS = 60000;
// Bindings that always reach Cloudflare: a run without a login cannot start them.
const REMOTE_ONLY = ['ai', 'browser', 'vectorize', 'images'];

const timeout = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms, { timeout: true }).unref());

// Ids and timestamps change on every run, so they do not count as a difference.
const stable = (s) =>
  s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<id>')
    .replace(/\b\d{10,}\b/g, '<n>');

// The built Worker config without what a local run cannot start. It stays next to the
// original, because the paths in it are relative to the config file. Without `routes`,
// `wrangler dev` keeps the local host in the request URL instead of the production domain.
function smokeConfig(workerDir) {
  const config = workerConfig(workerDir);
  const c = JSON.parse(fs.readFileSync(config, 'utf8'));
  delete c.legacy_env;
  delete c.containers;
  delete c.routes;
  delete c.route;
  for (const key of REMOTE_ONLY) delete c[key];
  for (const [key, value] of Object.entries(c)) {
    if (Array.isArray(value)) c[key] = value.filter((b) => b?.remote !== true);
  }
  const file = config.replace(/wrangler\.json$/, 'wrangler.smoke.json');
  fs.writeFileSync(file, JSON.stringify(c));
  return file;
}

// The start of the body with ids masked. A stream that does not end is cut after READ_MS.
async function bodyStart(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + READ_MS;
  let text = '';
  while (text.length < BODY_CHARS * 4) {
    const chunk = await Promise.race([reader.read(), timeout(Math.max(0, deadline - Date.now()))]);
    if (chunk.timeout || chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return stable(text.replace(/\s+/g, ' ').trim()).slice(0, BODY_CHARS);
}

async function smoke(workerDir, paths, port) {
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
  const args = ['dev', '-c', smokeConfig(workerDir), '--ip', '127.0.0.1', '--port', String(port)];
  args.push('--inspector-port', String(port + 1000), '--persist-to', persist);
  const child = spawn(WRANGLER, args, { cwd: workerDir, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const start = Date.now();
  while (!/Ready on/.test(log) && child.exitCode === null && Date.now() - start < READY_MS) {
    await timeout(200);
  }
  const ready = /Ready on/.test(log);
  const results = [];
  for (const p of ready ? paths : []) {
    const [pathname, accept] = p.split('|');
    try {
      const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        headers: accept ? { accept } : {},
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });
      results.push({ path: p, status: String(r.status), body: await bodyStart(r) });
    } catch (e) {
      results.push({ path: p, status: 'ERR', body: e.message });
    }
  }
  child.kill('SIGTERM');
  await Promise.race([exited, timeout(5000)]);
  child.kill('SIGKILL');
  fs.rmSync(persist, { recursive: true, force: true });
  log = log.replace(/\x1b\[[0-9;]*m/g, '');
  const errors = log.split('\n').filter((l) => /✘|\[ERROR\]|\bError:/.test(l)).slice(0, 4);
  return { ready, results, errors, log };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const port = Number(option(args, '--port', '8790'));
  const [name, ...labels] = args;
  if (!name || !labels.length) {
    console.error('usage: node harness/smoke.mjs [--port 8790] <app> <label>...');
    process.exit(2);
  }
  const a = app(name);
  if (!a.smoke?.length) throw new Error(`apps.json: no "smoke" paths for ${name}`);
  const runs = [];
  for (const [i, label] of labels.entries()) {
    const run = await smoke(path.join(WORK_ROOT, 'score', name, label, a.workerDir), a.smoke, port + i);
    runs.push({ label, ...run });
    console.log(`${name} ${label}`);
    if (!run.ready) {
      console.log(`  NOT READY\n${run.log.slice(-1500)}`);
      continue;
    }
    for (const r of run.results) console.log(`  ${r.status.padEnd(4)} ${r.path.padEnd(40)} ${r.body}`);
    for (const line of run.errors) console.log(`  log: ${line.trim().slice(0, 200)}`);
  }
  // Compare each copy with the first one, path by path.
  const [first, ...rest] = runs;
  let same = first.ready;
  for (const run of rest) {
    const differ = run.ready
      ? run.results.filter((r, i) => r.status !== first.results[i]?.status || r.body !== first.results[i]?.body)
      : run.results;
    if (!run.ready || !first.ready) {
      console.log(`${run.label} vs ${first.label}: not compared, a copy did not start`);
      same = false;
      continue;
    }
    console.log(`${run.label} vs ${first.label}: ${differ.length} of ${a.smoke.length} paths differ`);
    for (const r of differ) {
      const f = first.results.find((x) => x.path === r.path);
      console.log(`  ${r.path}\n    ${first.label}: ${f.status} ${f.body}\n    ${run.label}: ${r.status} ${r.body}`);
    }
    if (differ.length) same = false;
  }
  process.exit(same ? 0 : 1);
}
