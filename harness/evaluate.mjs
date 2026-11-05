// Applies an answer to a clean copy of the app (no perf-kit) and runs the gate:
// build, tests and typecheck. The built copy stays for score.mjs.
// The answer is the agent's commits after the baseline (--from), or a patch file (--patch).
// No answer means the base app.
// Usage: node harness/evaluate.mjs <app> <label> [--from <agentDir> | --patch <file>] [--out <dir>]
import fs from 'node:fs';
import path from 'node:path';

import { app, git, option, step, WORK_ROOT } from './lib.mjs';
import { IGNORED, prepare } from './prepare.mjs';

const EXCLUDE = IGNORED.map((p) =>
  p.endsWith('/') ? `:(exclude,glob)**/${p}**` : `:(exclude,glob)**/${p}`,
);
const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'resolutions',
  'overrides',
  'workspaces',
];

// The agent's kept work: every commit after the baseline, without tool output.
export function exportAnswer(agentDir) {
  const base = git(agentDir, 'rev-list', '--max-parents=0', 'HEAD').trim();
  const patch = git(agentDir, 'diff', '--binary', base, 'HEAD', '--', '.', ...EXCLUDE);
  const dirty = git(agentDir, 'status', '--porcelain').trim().split('\n').filter(Boolean);
  const commits = Number(git(agentDir, 'rev-list', '--count', `${base}..HEAD`).trim());
  return { patch, dirty, commits };
}

// Rules the prompt states that the build cannot check.
function forbiddenChanges(dir, files) {
  const problems = [];
  for (const file of files) {
    const base = path.basename(file);
    if (base === 'bun.lock') problems.push(`${file}: lockfile changed`);
    if (/^wrangler\.(json|jsonc|toml)$/.test(base)) problems.push(`${file}: wrangler config changed`);
    if (base === 'package.json') {
      let before, after;
      try {
        before = JSON.parse(git(dir, 'show', `HEAD:${file}`));
        after = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch {
        problems.push(`${file}: package.json added or removed`);
        continue;
      }
      for (const field of DEP_FIELDS) {
        if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
          problems.push(`${file}: "${field}" changed`);
        }
      }
    }
  }
  return problems;
}

export function evaluate(name, label, { from, patchFile, out }) {
  const a = app(name);
  out = path.resolve(out ?? path.join(WORK_ROOT, 'answers', name));
  fs.mkdirSync(out, { recursive: true });
  const result = { app: name, label, at: new Date().toISOString() };
  let patch = '';
  if (from) {
    const answer = exportAnswer(path.resolve(from));
    patch = answer.patch;
    result.commits = answer.commits;
    result.uncommitted = answer.dirty;
  } else if (patchFile) {
    patch = fs.readFileSync(patchFile, 'utf8');
  }
  const patchOut = path.join(out, `${label}.patch`);
  fs.writeFileSync(patchOut, patch);
  result.patch = patchOut;

  const dir = prepare(name, path.join(WORK_ROOT, 'score', name, label), { force: true });
  result.dir = dir;
  const logs = path.join(out, `${label}.logs`);
  fs.mkdirSync(logs, { recursive: true });
  result.steps = {};
  result.files = [];
  result.forbidden = [];
  if (patch.trim()) {
    const apply = step(`git apply --index --whitespace=nowarn "${patchOut}"`, dir, `${logs}/apply.log`);
    result.steps.apply = apply;
    if (apply.exit === 0) {
      result.files = git(dir, 'diff', '--cached', '--name-only').trim().split('\n');
      result.forbidden = forbiddenChanges(dir, result.files);
      git(dir, 'commit', '-q', '-m', `answer ${label}`);
      // A reference answer may change dependencies; the agents may not (see `forbidden`).
      if (result.forbidden.some((p) => /lockfile|Dependencies|resolutions|overrides|workspaces|added or removed/.test(p))) {
        result.steps.reinstall = step('bun install --ignore-scripts', dir, `${logs}/reinstall.log`);
      }
    }
  }
  const ready =
    (!patch.trim() || result.steps.apply.exit === 0) && (result.steps.reinstall?.exit ?? 0) === 0;
  if (ready) {
    const cwd = path.join(dir, a.workerDir);
    for (const s of ['build', 'test', 'typecheck']) {
      result.steps[s] = step(a[s], cwd, `${logs}/${s}.log`);
    }
  }
  const failed = Object.entries(result.steps)
    .filter(([, s]) => s.exit !== 0)
    .map(([k]) => k);
  if (!ready) failed.push('not run');
  // `pass`: the app still builds, tests and typechecks. `valid`: also keeps the agent rules.
  result.pass = failed.length === 0;
  result.valid = result.pass && result.forbidden.length === 0;
  result.failed = failed;
  fs.writeFileSync(path.join(out, `${label}.gate.json`), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const from = option(args, '--from');
  const patchFile = option(args, '--patch');
  const out = option(args, '--out');
  const [name, label] = args;
  if (!name || !label) {
    console.error(
      'usage: node harness/evaluate.mjs <app> <label> [--from <agentDir> | --patch <file>] [--out <dir>]',
    );
    process.exit(2);
  }
  const r = evaluate(name, label, { from, patchFile, out });
  const times = Object.entries(r.steps)
    .map(([k, s]) => `${k} ${s.exit === 0 ? 'ok' : `exit ${s.exit}`} ${(s.ms / 1000).toFixed(1)}s`)
    .join(', ');
  console.log(`${name} ${label}: ${r.pass ? 'PASS' : `FAIL (${r.failed.join('; ')})`} - ${times}`);
  if (r.forbidden.length) console.log(`breaks the agent rules: ${r.forbidden.join('; ')}`);
  console.log(`files: ${r.files.length}, patch: ${r.patch}, copy: ${r.dir}`);
  process.exit(r.valid ? 0 : 1);
}
