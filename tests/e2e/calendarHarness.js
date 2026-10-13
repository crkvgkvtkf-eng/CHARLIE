// Test harness for calendar/index.html (Charlie's Datebook).
//
// The page is authored for the claude.ai Artifact viewer, which wraps it in a document skeleton and
// provides `window.claude.use(name)`. These helpers reproduce both so Playwright can drive the exact
// file that gets published: `wrapPage()` adds the skeleton, `FAKE_CLAUDE` is an init script that
// installs an in-memory `db`, `user` and `downloads` runtime (or none, for the local-storage path).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PAGE_PATH = path.resolve(here, '../../calendar/index.html');
/** Origin the harness serves the page from (route-fulfilled; nothing listens there). */
export const PAGE_URL = 'http://datebook.test/';

/** The published page: skeleton + file content, the same shape the Artifact tool produces. */
export function wrapPage(content = fs.readFileSync(PAGE_PATH, 'utf8')) {
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>' +
    '</head><body>' + content + '</body></html>';
}

/**
 * Init script: a fake `window.claude` runtime. Options are read from `window.__fakeClaudeOptions`
 * (set it in an earlier addInitScript) :
 *   { db: true|false, canWrite: true|false|null, downloads: true|false, delayMs, seed: {id: doc},
 *     failWrites: false|'invalid_argument'|'quota_exceeded' }
 * Exposes `window.__fake` with `docs()` (current store), `saves` (downloads.save calls),
 * `externalSet(id, doc)` / `externalDelete(id)` to simulate another device writing.
 */
export const FAKE_CLAUDE = `
(() => {
  const opt = Object.assign({ db: true, canWrite: true, downloads: true, delayMs: 0, seed: {}, failWrites: false }, window.__fakeClaudeOptions || {});
  const store = new Map(Object.entries(opt.seed || {}).map(([id, d]) => [id, JSON.parse(JSON.stringify(d))]));
  const listeners = new Set();
  const snapDoc = (id, data) => ({ id, exists: data !== undefined, data: () => data === undefined ? undefined : JSON.parse(JSON.stringify(data)), metadata: { fromCache: false, hasPendingWrites: false } });
  const emit = () => {
    const docs = [...store.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([id, d]) => snapDoc(id, d));
    const snap = { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
    listeners.forEach(fn => { try { fn(snap); } catch (e) { console.error(e); } });
  };
  const wait = () => new Promise(r => setTimeout(r, opt.delayMs));
  const err = (code) => Object.assign(new Error(code), { code });
  const docRef = (collection, id) => ({
    id, path: collection + '/' + id,
    get: async () => { await wait(); return snapDoc(id, store.get(id)); },
    set: async (data) => { await wait(); if (opt.failWrites) throw err(opt.failWrites); if (opt.canWrite === false) throw err('invalid_argument'); if (!data || typeof data !== 'object' || Array.isArray(data)) throw err('invalid_argument'); store.set(id, JSON.parse(JSON.stringify(data))); emit(); },
    update: async (data) => { await wait(); if (!store.has(id)) throw err('invalid_argument'); store.set(id, Object.assign({}, store.get(id), data)); emit(); },
    delete: async () => { await wait(); if (opt.failWrites) throw err(opt.failWrites); if (opt.canWrite === false) throw err('invalid_argument'); store.delete(id); emit(); },
    onSnapshot: (next) => { const fn = () => next(snapDoc(id, store.get(id))); listeners.add(fn); setTimeout(fn, 0); return () => listeners.delete(fn); },
    collection: (p) => collectionRef(collection + '/' + id + '/' + p),
  });
  const checkPath = (p, even) => { const n = p.split('/').length; if ((n % 2 === 0) !== even) throw new TypeError('bad path parity: ' + p); };
  const collectionRef = (collection) => ({
    path: collection,
    doc: (id) => { id = id || ('f' + Math.random().toString(36).slice(2, 12)); checkPath(collection + '/' + id, true); return docRef(collection, id); },
    add: async (data) => { const r = docRef(collection, 'f' + Math.random().toString(36).slice(2, 12)); await r.set(data); return r; },
    where() { return this; }, orderBy() { return this; }, limit() { return this; },
    get: async () => { await wait(); const docs = [...store.entries()].map(([id, d]) => snapDoc(id, d)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } }; },
    onSnapshot: (next, error) => { listeners.add(next); setTimeout(emit, opt.delayMs); return () => listeners.delete(next); },
  });
  const db = Object.freeze({ doc: (p) => { checkPath(p, true); const i = p.lastIndexOf('/'); return docRef(p.slice(0, i), p.slice(i + 1)); }, collection: (p) => { checkPath(p, false); return collectionRef(p); } });
  const user = Object.freeze({
    isOwner: async () => true, canEdit: async () => true,
    can: async (name) => name === 'data.write' ? opt.canWrite : true,
    me: async () => ({ id: 'u_test', name: 'Charlie', avatarUrl: 'data:,', color: '#0d6b66', email: null, isOwner: true, canEdit: true }),
    id: async () => 'u_test', profiles: async (ids) => Object.fromEntries([].concat(ids).map(id => [id, { id, name: '', avatarUrl: 'data:,', color: '#888', email: null, isMe: id === 'u_test', guest: false }])),
    name: async () => 'Charlie', avatarUrl: async () => null, search: async () => [], email: async () => null,
  });
  const saves = [];
  const downloads = Object.freeze({ save: async (req) => { saves.push({ filename: req.filename, data: typeof req.data === 'string' ? req.data : '[binary]' }); if (opt.declineDownload) throw err('declined'); return { status: 'saved' }; } });
  const memo = {};
  window.claude = {
    use: (name) => {
      if (!(name in memo)) {
        memo[name] = new Promise(resolve => setTimeout(() => {
          if (name === 'db') resolve(opt.db ? db : null);
          else if (name === 'user') resolve(user);
          else if (name === 'downloads') resolve(opt.downloads ? downloads : null);
          else resolve(null);
        }, opt.delayMs));
      }
      return memo[name];
    },
  };
  window.__fake = {
    docs: () => Object.fromEntries([...store.entries()]),
    saves,
    externalSet: (id, doc) => { store.set(id, JSON.parse(JSON.stringify(doc))); emit(); },
    externalDelete: (id) => { store.delete(id); emit(); },
  };
})();
`;

/** Open the published page in `page` with the fake runtime (or none when options.db === 'none'). */
export async function openDatebook(page, options = {}) {
  const { clock, ...fakeOptions } = options;
  if (clock) await page.clock.install({ time: clock });
  if (fakeOptions.db !== 'none') {
    await page.addInitScript(`window.__fakeClaudeOptions = ${JSON.stringify(fakeOptions)};`);
    await page.addInitScript(FAKE_CLAUDE);
  }
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  // Serve the wrapped page from a stable origin so init scripts run and localStorage works as on a real host.
  await page.route(PAGE_URL + '**', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: wrapPage() }));
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid .day');
  return page;
}
