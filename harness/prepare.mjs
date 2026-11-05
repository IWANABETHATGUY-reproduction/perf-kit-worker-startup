// Copies an eval app to a work folder, installs it and commits a baseline.
// With --perf-kit, the root package.json also gets the perf-kit tarball (arm B).
// Usage: node harness/prepare.mjs <app> <dir> [--perf-kit <tgz>] [--force]
import fs from 'node:fs';
import path from 'node:path';

import { app, flag, git, option, step } from './lib.mjs';

// Build output and tool state; never part of an answer.
export const IGNORED = [
  'node_modules/',
  'dist/',
  'dist-attrib/',
  '.perf-kit/',
  '.wrangler/',
  '.data/',
  'perf-kit.vite.config.ts',
  '*.log',
];

const COPY_SKIP_TOP = new Set(['dist', '.next', '.vinext', '.wrangler', 'next-env.d.ts']);

export function prepare(name, dir, { perfKit, force } = {}) {
  const a = app(name);
  dir = path.resolve(dir);
  if (fs.existsSync(dir)) {
    if (!force) throw new Error(`${dir} exists; pass --force to replace it`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // A source folder may hold its own git history, installs or build output; a copy starts clean.
  fs.cpSync(a.src, dir, {
    recursive: true,
    filter: (from) => {
      const parts = path.relative(a.src, from).split(path.sep);
      return !parts.some((p) => p === '.git' || p === 'node_modules') && !COPY_SKIP_TOP.has(parts[0]);
    },
  });
  if (perfKit) {
    const file = path.join(dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.devDependencies = {
      ...pkg.devDependencies,
      '@rolldown/perf-kit': `file:${path.resolve(perfKit)}`,
    };
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  // A clean copy must install the committed lockfile as it is.
  const install = step(
    `bun install --ignore-scripts${perfKit ? '' : ' --frozen-lockfile'}`,
    dir,
    `${dir}.install.log`,
  );
  if (install.exit !== 0) throw new Error(`bun install failed; see ${install.log}`);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'eval');
  git(dir, 'config', 'user.email', 'eval@localhost');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), `${IGNORED.join('\n')}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'baseline');
  return dir;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const perfKit = option(args, '--perf-kit');
  const force = flag(args, '--force');
  const [name, dir] = args;
  if (!name || !dir) {
    console.error('usage: node harness/prepare.mjs <app> <dir> [--perf-kit <tgz>] [--force]');
    process.exit(2);
  }
  console.log(`prepared ${prepare(name, dir, { perfKit, force })}`);
}
