// One agent run, in two steps around the agent.
//   start:  prepares the run folder and writes the prompt next to it.
//   finish: stops the processes the run left, gates the answer, keeps the git history
//           as a bundle, then deletes the folder so that later runs cannot read it.
// Usage: node harness/run.mjs start <round> <app> <A|B> <n> [--perf-kit <tgz>]
//        node harness/run.mjs finish <round> <app> <A|B> <n>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { evaluate } from './evaluate.mjs';
import { git, option, WORK_ROOT } from './lib.mjs';
import { prepare } from './prepare.mjs';
import { prompt } from './prompt.mjs';

const args = process.argv.slice(2);
const perfKit = option(args, '--perf-kit');
const [cmd, round, name, arm, n] = args;
if (!['start', 'finish'].includes(cmd) || !round || !name || !['A', 'B'].includes(arm) || !n) {
  console.error('usage: node harness/run.mjs <start|finish> <round> <app> <A|B> <n> [--perf-kit <tgz>]');
  process.exit(2);
}
const label = `${round}-${arm}${n}`;
const dir = path.join(WORK_ROOT, 'runs', round, `${name}-${arm}${n}`);
const out = path.join(WORK_ROOT, 'answers', name);

if (cmd === 'start') {
  if (arm === 'B' && !perfKit) throw new Error('arm B needs --perf-kit <tgz>');
  if (arm === 'A' && perfKit) throw new Error('arm A gets no perf-kit');
  prepare(name, dir, { perfKit });
  const text = prompt(name, dir, arm);
  fs.writeFileSync(`${dir}.prompt.txt`, `${text}\n`);
  console.log(`run folder: ${dir}\nprompt: ${dir}.prompt.txt`);
} else {
  // Servers that perf-kit or wrangler started inside the folder.
  try {
    const pids = execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' }).trim().split('\n');
    for (const pid of pids.filter(Boolean)) process.kill(Number(pid), 'SIGKILL');
    console.log(`stopped ${pids.length} leftover processes`);
  } catch {
    // pgrep exits 1 when nothing matches.
  }
  const r = evaluate(name, label, { from: dir, out });
  git(dir, 'bundle', 'create', path.join(out, `${label}.bundle`), '--all');
  fs.rmSync(dir, { recursive: true, force: true });
  const times = Object.entries(r.steps)
    .map(([k, s]) => `${k} ${s.exit === 0 ? 'ok' : `exit ${s.exit}`} ${(s.ms / 1000).toFixed(1)}s`)
    .join(', ');
  console.log(`${name} ${label}: ${r.valid ? 'VALID' : `INVALID (${[...r.failed, ...r.forbidden].join('; ')})`} - ${times}`);
  console.log(`commits ${r.commits}, uncommitted ${r.uncommitted.length}, files ${r.files.length}`);
  console.log(`patch: ${r.patch}\ncopy for score.mjs: ${r.dir}`);
}
