// Prints the agent prompt for one run. Arm A gets the requirement only.
// Arm B gets the same requirement plus the perf-kit tools block.
// Usage: node harness/prompt.mjs <app> <dir> <A|B>
import path from 'node:path';

import { app } from './lib.mjs';

export function prompt(name, dir, arm) {
  const a = app(name);
  dir = path.resolve(dir);
  const at = a.workerDir === '.' ? 'DIR' : `DIR/${a.workerDir}`;
  const lines = [
    `Task: lower the Cloudflare Worker startup time of the app in DIR=${dir}`,
    '',
    ...(a.about ? [a.about, ''] : []),
    'Startup time is the CPU time the Worker spends in its global scope when a new isolate loads the script (module evaluation before the first request). Cloudflare limits this time.',
    '',
    'Rules:',
    '- Work only inside DIR. Do not read or change files outside DIR.',
    '- Do not use the network: no web search, no web fetch, no git fetch or clone.',
    '- Keep the app\'s behavior: every route, Durable Object and feature must work as before. Do not remove features.',
    `- The app must still build with \`${a.build}\` (run in ${at}). Its tests must still pass (\`${a.test}\` in ${at}). Do not add TypeScript errors (\`${a.typecheck}\` in ${at}).`,
    '- Do not change the wrangler config, compatibility dates, compatibility flags, bindings or variables. Do not deploy or upload.',
    '- Do not install, remove or upgrade packages.',
    `- Budget: at most 10 rounds. A round is one code change followed by one build. Stop after round 10, or earlier when you have no more ideas.${arm === 'B' ? ' This budget overrides any instruction in a tool\'s AGENTS.md to continue.' : ''}`,
    '- DIR is a git repository. Commit each change you keep (one commit per kept change). Revert each change you do not keep.',
    '',
  ];
  if (arm === 'B') {
    lines.push(
      `Tools: perf-kit is installed in this app. It measures the Worker startup and shows which modules cost the time. Use \`npx perf-kit <command>\` for every perf-kit command (not \`npx @rolldown/perf-kit\`), run in ${at}.`,
      '1. Before round 1, read `DIR/node_modules/@rolldown/perf-kit/AGENTS.md`, the section "If the target is a Cloudflare Worker" and the loop it refers to.',
      `2. Setup (not a round): \`npx perf-kit worker-config --app .\`, then \`npx vite build --config perf-kit.vite.config.ts\`, then \`npx perf-kit worker-scan --app .${a.scanWorker ? ` --worker ${a.scanWorker}` : ''} --request ${a.request} --pin\`.${a.scanNote ? ` ${a.scanNote}` : ''}`,
      '3. Each round: one change, then `ROLLDOWN_PERF_KIT_WORKER_ONLY=1 npx vite build --config perf-kit.vite.config.ts`, then `npx perf-kit worker-scan`. Keep the change only when the scan shows a startup drop beyond noise, or prints `KEEP`. `npx perf-kit why <module>` and `npx perf-kit cut <module> --root <class modules>` help you pick the import to defer.',
      '',
      'Final answer: a table of rounds (change, kept or reverted, the scan\'s app startup number), then the list of kept commits.',
    );
  } else {
    lines.push(
      'Final answer: a table of rounds (change, kept or reverted, any number you measured), then the list of kept commits.',
    );
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const [name, dir, arm] = process.argv.slice(2);
  if (!name || !dir || !['A', 'B'].includes(arm)) {
    console.error('usage: node harness/prompt.mjs <app> <dir> <A|B>');
    process.exit(2);
  }
  console.log(prompt(name, dir, arm));
}
