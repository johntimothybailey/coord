import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
let errors = 0;
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { await check(path); continue; }
    if (!path.endsWith('.ts')) continue;
    const source = await readFile(path, 'utf8');
    for (const [index, line] of source.split('\n').entries()) {
      if (/\s+$/.test(line) || /@ts-(ignore|nocheck)/.test(line) || /\beval\s*\(/.test(line)) {
        console.error(`${path}:${index + 1}: trailing whitespace, suppressed typecheck, or eval`); errors++;
      }
    }
  }
}
await Promise.all(['src', 'convex', 'tests'].map(check));
if (errors) process.exitCode = 1;
else console.log('Static source hygiene checks passed (not a security audit).');
