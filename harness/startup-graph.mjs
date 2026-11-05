// Lists the modules that a built Worker loads at startup, and diffs builds. No CPU timing:
// the same build always gives the same result.
//
// The startup graph is the static import closure of the Worker's main module: every chunk
// that `import ... from` reaches, without `import()`. Each module of such a chunk counts,
// by the `// <module path>` comment that the bundler writes before it. An imported file
// that is not JavaScript (a text or wasm module) counts as one module, `file:<path>`.
// A module that the bundler wraps for lazy init also counts, so the list can be a little
// too large.
//
// The first build is the reference. For each other build, the output lists the modules that
// load at startup only in that build, and only in the reference, grouped by package or folder.
// With --checks, each line `<name> <pattern>...` passes when no startup module matches a
// pattern: an exact module id, a prefix that ends with `/`, or a glob with `*` (`**` also
// matches `/`).
// Usage: node harness/startup-graph.mjs [--json <file>] [--checks <file>] [--top 15] <label>=<workerDir>...
import fs from 'node:fs';
import path from 'node:path';

import { option, workerConfig } from './lib.mjs';

const STATIC_IMPORT = /^(?:import|export)\b[^;'"`]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']|^import\s*["'](\.{1,2}\/[^"']+)["']/gm;
const REGION = /^\/\/ (\S+)$/;
// Above this share of bytes outside module comments, the module list is not reliable.
const MAX_OUTSIDE = 0.25;
// A module comment names a file path with an extension, or a virtual module (`\0virtual:...`).
const isModulePath = (s) =>
  s.startsWith('\\0') || (s.includes('/') && !/^[a-z]+:\/\//.test(s) && /\.(?:[cm]?[jt]sx?|json|wasm|sql|txt|md|css|html)$/.test(s));

// `../../node_modules/.bun/zod@4.1.0/node_modules/zod/v4/x.js` -> `node_modules/zod/v4/x.js`.
export function moduleId(p) {
  const i = p.lastIndexOf('node_modules/');
  if (i >= 0) return p.slice(i);
  return p.replace(/^(\.\.\/)+/, '');
}

// `node_modules/@scope/name/...` -> `node_modules/@scope/name/`; `src/a/b.ts` -> `src/a/`;
// `file:assets/m-1a2b.sql` -> `file:*.sql`.
export function groupOf(id) {
  if (id.startsWith('file:')) return `file:*${path.extname(id)}`;
  const parts = id.split('/');
  if (parts[0] === 'node_modules') return `${parts.slice(0, parts[1]?.startsWith('@') ? 3 : 2).join('/')}/`;
  return parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : id;
}

export function startupGraph(workerDir) {
  const config = workerConfig(workerDir);
  const main = path.resolve(path.dirname(config), JSON.parse(fs.readFileSync(config, 'utf8')).main);
  const chunks = new Map();
  // Imported files that are not JavaScript (text, data or wasm modules): one module each.
  const files = new Map();
  const queue = [main];
  while (queue.length) {
    const file = queue.pop();
    if (chunks.has(file) || files.has(file)) continue;
    if (!/\.[cm]?js$/.test(file)) {
      files.set(file, fs.statSync(file).size);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    chunks.set(file, text);
    for (const m of text.matchAll(STATIC_IMPORT)) queue.push(path.resolve(path.dirname(file), m[1] ?? m[2]));
  }
  // Module id -> bytes, from one region comment to the next.
  const modules = new Map();
  let bytes = 0;
  const outDir = path.dirname(main);
  for (const [file, size] of files) {
    modules.set(`file:${path.relative(outDir, file)}`, size);
    bytes += size;
  }
  for (const text of chunks.values()) {
    bytes += Buffer.byteLength(text);
    const lines = text.split('\n');
    let current = null;
    for (const line of lines) {
      const m = REGION.exec(line);
      if (m && isModulePath(m[1])) {
        current = moduleId(m[1]);
        if (!modules.has(current)) modules.set(current, 0);
      } else if (current) {
        modules.set(current, modules.get(current) + Buffer.byteLength(line) + 1);
      }
    }
  }
  // Chunk headers and import lines have no module comment: 1 to 6% of the bytes in a normal
  // build. A minified build has no module comments, so its module list is empty or too small.
  const outside = bytes - [...modules.values()].reduce((s, b) => s + b, 0);
  return {
    main: path.relative(workerDir, main),
    chunks: [...chunks.keys()].map((f) => path.relative(workerDir, f)),
    files: files.size,
    bytes,
    modules,
    complete: outside <= bytes * MAX_OUTSIDE,
  };
}


function matcher(pattern) {
  if (pattern.includes('*')) {
    const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
    return (id) => re.test(id);
  }
  if (pattern.endsWith('/')) return (id) => id.startsWith(pattern);
  return (id) => id === pattern;
}

export function runChecks(graph, checksText) {
  const results = [];
  for (const raw of checksText.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [name, ...patterns] = line.split(/\s+/);
    const hits = [...graph.modules.keys()].filter((id) => patterns.some((p) => matcher(p)(id)));
    results.push({ name, patterns, pass: hits.length === 0, hits: hits.slice(0, 5), hitCount: hits.length });
  }
  return results;
}

const kib = (b) => `${(b / 1024).toFixed(1)} KiB`;

function grouped(ids, modules) {
  const g = new Map();
  for (const id of ids) {
    const k = groupOf(id);
    const e = g.get(k) ?? { bytes: 0, count: 0 };
    e.bytes += modules.get(id);
    e.count += 1;
    g.set(k, e);
  }
  return [...g].sort((a, b) => b[1].bytes - a[1].bytes);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = option(args, '--json');
  const checksFile = option(args, '--checks');
  const top = Number(option(args, '--top', '15'));
  const copies = args.map((a) => {
    const i = a.indexOf('=');
    if (i < 1) throw new Error(`expected <label>=<workerDir>, got "${a}"`);
    return [a.slice(0, i), path.resolve(a.slice(i + 1))];
  });
  if (copies.length === 0) {
    console.error('usage: node harness/startup-graph.mjs [--json <file>] [--checks <file>] [--top 15] <label>=<workerDir>...');
    process.exit(2);
  }
  const checksText = checksFile ? fs.readFileSync(checksFile, 'utf8') : null;
  const out = [];
  for (const [label, dir] of copies) {
    const g = startupGraph(dir);
    const checks = checksText ? runChecks(g, checksText) : [];
    // Startup modules that the reference does not load: the distance to the reference.
    const ref = out[0]?.g;
    const extra = ref ? [...g.modules.keys()].filter((id) => !ref.modules.has(id)) : [];
    const extraBytes = extra.reduce((s, id) => s + g.modules.get(id), 0);
    out.push({ label, dir, g, checks, extra: { modules: extra.length, bytes: extraBytes } });
    const passed = checks.filter((c) => c.pass).map((c) => c.name);
    console.log(
      `${label.padEnd(12)} ${String(g.chunks.length).padStart(4)} chunks ${String(g.files).padStart(4)} files ${kib(g.bytes).padStart(12)} ${String(g.modules.size).padStart(5)} modules` +
        (ref ? `   +${extra.length} modules (+${kib(extraBytes)}) vs ${out[0].label}` : '') +
        (checksText ? `   checks passed: ${passed.length}/${checks.length} ${passed.join(' ')}` : ''),
    );
    if (!g.complete) {
      console.log(
        `${label}: more than ${MAX_OUTSIDE * 100}% of the startup bytes have no module comment (minified build?). ` +
          'The module list and the checks are not reliable.',
      );
    }
  }
  const [ref, ...rest] = out;
  for (const o of rest) {
    const onlyHere = [...o.g.modules.keys()].filter((id) => !ref.g.modules.has(id));
    const onlyRef = [...ref.g.modules.keys()].filter((id) => !o.g.modules.has(id));
    for (const [title, ids, mods] of [
      [`only in ${o.label} (startup modules that ${ref.label} does not load)`, onlyHere, o.g.modules],
      [`only in ${ref.label}`, onlyRef, ref.g.modules],
    ]) {
      const groups = grouped(ids, mods);
      const total = ids.reduce((s, id) => s + mods.get(id), 0);
      console.log(`--- ${title}: ${ids.length} modules, ${kib(total)}`);
      for (const [k, e] of groups.slice(0, top)) console.log(`${kib(e.bytes).padStart(12)} ${String(e.count).padStart(4)}  ${k}`);
      if (groups.length > top) console.log(`${''.padStart(12)} ... ${groups.length - top} more groups`);
    }
  }
  for (const o of out) {
    for (const c of o.checks.filter((c) => !c.pass)) {
      console.log(`${o.label}: ${c.name} fails, ${c.hitCount} startup modules match, e.g. ${c.hits.join(', ')}`);
    }
  }
  if (json) {
    const data = out.map(({ label, dir, g, checks, extra }) => ({
      label,
      dir,
      main: g.main,
      chunks: g.chunks,
      bytes: g.bytes,
      complete: g.complete,
      extra,
      checks,
      modules: Object.fromEntries(g.modules),
    }));
    fs.writeFileSync(json, `${JSON.stringify(data, null, 2)}\n`);
  }
}
