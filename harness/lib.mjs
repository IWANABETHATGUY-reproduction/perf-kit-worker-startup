// Shared paths and helpers for the eval harness.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const EVAL_ROOT = path.resolve(import.meta.dirname, '..');
// A `.noindex` folder: Spotlight does not index the copies while agents build them.
export const WORK_ROOT = path.resolve(
  process.env.PERF_KIT_EVAL_WORK ?? path.join(EVAL_ROOT, '../perf-kit-eval-work.noindex'),
);
export const WRANGLER = path.join(import.meta.dirname, 'node_modules/.bin/wrangler');

const apps = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'apps.json'), 'utf8'));
// PERF_KIT_EVAL_APPS names one more apps file, for apps outside apps/ (each entry sets `src`).
if (process.env.PERF_KIT_EVAL_APPS) {
  Object.assign(apps, JSON.parse(fs.readFileSync(process.env.PERF_KIT_EVAL_APPS, 'utf8')));
}

export function app(name) {
  const a = apps[name];
  if (!a) throw new Error(`unknown app "${name}"; known: ${Object.keys(apps).join(', ')}`);
  return { name, src: path.join(EVAL_ROOT, 'apps', name), ...a };
}

// Runs a shell command with its output in logFile; returns the exit code and the time.
export function step(cmd, cwd, logFile, env = {}) {
  const start = Date.now();
  const fd = fs.openSync(logFile, 'w');
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    cwd,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, CI: '1', NO_COLOR: '1', ...env },
  });
  fs.closeSync(fd);
  return { exit: r.status ?? 1, ms: Date.now() - start, log: logFile };
}

export const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

export function option(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
}

export function flag(args, name) {
  const i = args.indexOf(name);
  if (i !== -1) args.splice(i, 1);
  return i !== -1;
}

// The folders that can hold the built Worker: `dist` (Vite) and `build` (React Router).
const OUTPUT_DIRS = ['dist', 'build'];

// The Worker's wrangler.json in the Vite output; the client folder holds only assets.
// With auxiliary Workers, the main one is the config that the Cloudflare Vite plugin
// names in `.wrangler/deploy/config.json` (the file `wrangler deploy` reads).
export function workerConfig(workerDir) {
  const found = OUTPUT_DIRS.flatMap((out) => {
    const dir = path.join(workerDir, out);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((d) => d !== 'client' && fs.existsSync(path.join(dir, d, 'wrangler.json')))
      .map((d) => `${out}/${d}`);
  });
  const redirect = path.join(workerDir, '.wrangler', 'deploy', 'config.json');
  if (found.length > 1 && fs.existsSync(redirect)) {
    const { configPath } = JSON.parse(fs.readFileSync(redirect, 'utf8'));
    const main = configPath && path.resolve(path.dirname(redirect), configPath);
    const hit = found.find((f) => path.resolve(workerDir, f, 'wrangler.json') === main);
    if (hit) return path.join(workerDir, hit, 'wrangler.json');
  }
  if (found.length !== 1) {
    const where = OUTPUT_DIRS.map((out) => `${out}/`).join(' or ');
    throw new Error(
      `${workerDir}: expected one <worker>/wrangler.json in ${where}, found ${found.join(', ') || 'none'}`,
    );
  }
  return path.join(workerDir, found[0], 'wrangler.json');
}
