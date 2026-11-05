// Applies the eval changes to a fresh `git archive` export of an app:
// removes agent files and unused workspaces, pins the toolchain versions, and applies
// the source edits of `patch`.
// Usage: node sources/prepare-app.mjs <appDir> <spec.json>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [appDir, specFile] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
for (const rel of spec.remove ?? []) {
  fs.rmSync(path.join(appDir, rel), { recursive: true, force: true });
}
for (const [rel, edit] of Object.entries(spec.packageJson ?? {})) {
  const file = path.join(appDir, rel);
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const name of edit.removeScripts ?? []) delete pkg.scripts?.[name];
  // `removeKeys` deletes top-level fields, such as settings that moved to other fields.
  for (const key of edit.removeKeys ?? []) delete pkg[key];
  for (const [section, deps] of Object.entries(edit.set ?? {})) {
    pkg[section] ??= {};
    Object.assign(pkg[section], deps);
  }
  // `replace` sets a top-level field as a whole, for fields that are not objects.
  for (const [key, value] of Object.entries(edit.replace ?? {})) pkg[key] = value;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
// `patch` names a diff next to the spec, for source edits that the build or the typecheck needs.
// The ceiling stops git from taking a repository above appDir, which would skip the files.
if (spec.patch) {
  execFileSync('git', ['apply', path.resolve(path.dirname(specFile), spec.patch)], {
    cwd: appDir,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(appDir)) },
    stdio: 'inherit',
  });
}
console.log(`prepared ${appDir}`);
