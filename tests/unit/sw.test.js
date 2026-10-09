// SPEC §13 "sw": the service worker's PRECACHE list must match the app files on disk, so a new
// module or stylesheet cannot be forgotten (an installed app would then fail offline).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Entries that must always be precached, whether or not the file exists at test time. */
const ALWAYS = ['./', './index.html', './manifest.webmanifest'];

/** Relative `./dir/file` paths of every file under `dir` (recursively); [] when `dir` is missing. */
function filesUnder(dir, { recursive = true, filter = () => true } = {}) {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (recursive) out.push(...filesUnder(rel, { recursive, filter }));
    } else if (filter(entry.name)) {
      out.push(`./${rel}`);
    }
  }
  return out;
}

/** The string literals of the `const PRECACHE = [...]` array in sw.js, parsed from source. */
function readPrecache() {
  const src = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const m = src.match(/const\s+PRECACHE\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, 'sw.js must declare `const PRECACHE = [ ... ];`');
  return Array.from(m[1].matchAll(/(['"])([^'"]+)\1/g), (x) => x[2]);
}

test('sw.js PRECACHE equals the app shell files on disk', () => {
  const expected = [
    ...ALWAYS,
    ...filesUnder('css'),
    ...filesUnder('js'),
    ...filesUnder('vendor', { recursive: false, filter: (name) => name.endsWith('.js') }),
    ...filesUnder('icons', { recursive: false }),
  ];
  const actual = readPrecache();
  assert.equal(new Set(actual).size, actual.length, 'PRECACHE has duplicate entries');
  assert.deepEqual([...new Set(actual)].sort(), [...new Set(expected)].sort());
});

test('every PRECACHE entry is a relative URL (GitHub Pages serves the app under a sub-path)', () => {
  for (const entry of readPrecache()) assert.ok(entry.startsWith('./'), `${entry} must start with ./`);
});

test('CACHE name is versioned as ssb-v<N>', () => {
  const src = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(src, /const\s+CACHE\s*=\s*'ssb-v\d+'/);
});
