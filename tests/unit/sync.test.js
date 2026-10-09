// Unit tests for js/sync.js (SPEC §7, §13): client error mapping, pure merge rules, runSync flow.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setClock, setIdFactory } from '../../js/ids.js';
import * as M from '../../js/model.js';
import { serializeExport, parseImport } from '../../js/storage.js';
import {
  GIST_FILENAME, GIST_SCOPE_MESSAGE, UNREADABLE_REMOTE_MESSAGE, SyncError,
  createClient, merge, runSync, syncedMapOf,
} from '../../js/sync.js';

let tick;
let idCounter;
beforeEach(() => {
  tick = 0;
  idCounter = 0;
  setClock(() => new Date(Date.UTC(2024, 0, 1) + ++tick * 1000));
  setIdFactory(() => `id${++idCounter}`);
});
afterEach(() => {
  setClock(null);
  setIdFactory(null);
});

// ---------------------------------------------------------------------------
// Fixtures

const T = (n) => new Date(Date.UTC(2024, 0, 1) + n * 1000).toISOString();

/** A workspace with one topic and one joke (in the set) in its single version. */
function seeded({ title = 'Cats', text = 'hello there' } = {}) {
  const ws = M.createWorkspace();
  const topicId = M.addTopic(ws, { title });
  const jokeId = M.addJoke(ws, topicId, { text });
  M.addToSet(ws, jokeId);
  return { ws, topicId, jokeId };
}

const clone = (x) => structuredClone(x);
const versionIds = (ws) => ws.versions.map((v) => v.id).sort();
const versionSetJson = (ws) => stable(ws.versions.slice().sort((a, b) => (a.id < b.id ? -1 : 1)));
const stable = M.stableJson;
const byId = (ws, id) => ws.versions.find((v) => v.id === id);

/** Asserts that merge(a, b) and merge(b, a) keep the same version set, and returns merge(a, b). */
function mergeBothWays(a, b, opts) {
  const ab = merge(a, b, opts);
  const ba = merge(b, a, opts);
  assert.equal(versionSetJson(ab.workspace), versionSetJson(ba.workspace), 'merge is symmetric');
  assert.deepEqual(ab.workspace.tombstones, ba.workspace.tombstones);
  return ab;
}

// ---------------------------------------------------------------------------
// Fake GitHub over fetch

const API = 'https://api.github.com';
const RAW_HOST = 'https://gist.githubusercontent.com';

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * In-memory gist API. `calls` records every request; `respond(method, path, req)` can be set to
 * inject a canned Response for error-mapping tests; `truncate` makes GET /gists/:id report the
 * file as truncated and serve its content from raw_url.
 */
function fakeGithub({ login = 'alice', scopes = 'gist', gists = [], truncate = false } = {}) {
  const state = { gists: new Map(gists.map((g) => [g.id, g])), seq: 0, time: 0, calls: [], respond: null, truncate };
  const nextTime = () => T(1000 + ++state.time);

  const summary = (g, withContent) => ({
    id: g.id,
    updated_at: g.updated_at,
    files: Object.fromEntries(
      Object.entries(g.files).map(([name, content]) => [
        name,
        {
          filename: name,
          raw_url: `${RAW_HOST}/${login}/${g.id}/raw/${name}`,
          truncated: withContent && state.truncate,
          ...(withContent ? { content: state.truncate ? content.slice(0, 10) : content } : {}),
        },
      ]),
    ),
  });

  async function fetch(url, init = {}) {
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { method, url, path: u.pathname, search: u.searchParams, headers, body, init };
    state.calls.push(call);

    const injected = state.respond?.(method, u.pathname, call);
    if (injected) return injected;

    if (u.origin === RAW_HOST) {
      const [, , gistId, , name] = u.pathname.split('/');
      const gist = state.gists.get(gistId);
      if (!gist || !(name in gist.files)) return jsonResponse(404, { message: 'Not Found' });
      return new Response(gist.files[name], { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (!/^Bearer \S+$/.test(headers.authorization || '')) return jsonResponse(401, { message: 'Bad credentials' });

    if (method === 'GET' && u.pathname === '/user') {
      return jsonResponse(200, { login }, scopes === null ? {} : { 'x-oauth-scopes': scopes });
    }
    if (u.pathname === '/gists' && method === 'GET') {
      const perPage = Number(u.searchParams.get('per_page'));
      const page = Number(u.searchParams.get('page'));
      const all = [...state.gists.values()];
      return jsonResponse(200, all.slice((page - 1) * perPage, page * perPage).map((g) => summary(g, false)));
    }
    if (u.pathname === '/gists' && method === 'POST') {
      const id = `gist${++state.seq}`;
      const gist = { id, description: body.description, public: body.public, updated_at: nextTime(), files: {} };
      for (const [name, spec] of Object.entries(body.files)) gist.files[name] = spec.content;
      state.gists.set(id, gist);
      return jsonResponse(201, summary(gist, true));
    }
    const m = u.pathname.match(/^\/gists\/([^/]+)$/);
    if (m) {
      const gist = state.gists.get(m[1]);
      if (!gist) return jsonResponse(404, { message: 'Not Found' });
      if (method === 'GET') return jsonResponse(200, summary(gist, true));
      if (method === 'PATCH') {
        for (const [name, spec] of Object.entries(body.files)) gist.files[name] = spec.content;
        gist.updated_at = nextTime();
        return jsonResponse(200, summary(gist, true));
      }
    }
    return jsonResponse(404, { message: 'Not Found' });
  }

  return { state, fetch, client: createClient({ token: 'ghp_test', fetch, now: () => Date.UTC(2024, 0, 1) }) };
}

/** A stored gist holding `ws` as its export envelope. */
function gistWith(ws, id = 'gistA') {
  return { id, updated_at: T(500), files: { [GIST_FILENAME]: serializeExport(ws) } };
}

/** The workspace currently stored in gist `id`. */
function remoteWorkspace(fake, id) {
  return parseImport(fake.state.gists.get(id).files[GIST_FILENAME]);
}

// ---------------------------------------------------------------------------
// Client

describe('createClient', () => {
  test('sends the auth, accept and api-version headers on every API request', async () => {
    const fake = fakeGithub();
    await fake.client.whoami();
    await fake.client.findGist();
    for (const call of fake.state.calls) {
      assert.equal(call.headers.authorization, 'Bearer ghp_test');
      assert.equal(call.headers.accept, 'application/vnd.github+json');
      assert.equal(call.headers['x-github-api-version'], '2022-11-28');
      assert.ok(call.url.startsWith(`${API}/`));
    }
  });

  test('whoami parses the comma-separated X-OAuth-Scopes header', async () => {
    const fake = fakeGithub({ login: 'bob', scopes: 'gist, read:user' });
    assert.deepEqual(await fake.client.whoami(), { login: 'bob', scopes: ['gist', 'read:user'] });
    assert.equal(fake.state.calls[0].path, '/user');
  });

  test('whoami without the scopes header → scopes []', async () => {
    const fake = fakeGithub({ scopes: null });
    assert.deepEqual(await fake.client.whoami(), { login: 'alice', scopes: [] });
  });

  test('findGist pages 100 at a time and returns the first gist carrying the data file', async () => {
    const others = Array.from({ length: 100 }, (_, i) => ({ id: `other${i}`, updated_at: T(i), files: { 'notes.txt': 'x' } }));
    const fake = fakeGithub({ gists: [...others, { id: 'noise', updated_at: T(1), files: { 'a.json': '{}' } }, gistWith(M.createWorkspace(), 'ours')] });
    assert.deepEqual(await fake.client.findGist(), { id: 'ours', updated_at: T(500) });
    const pages = fake.state.calls.map((c) => [c.path, c.search.get('per_page'), c.search.get('page')]);
    assert.deepEqual(pages, [['/gists', '100', '1'], ['/gists', '100', '2']]);
  });

  test('findGist stops at a short page and gives up after five full pages', async () => {
    const fake = fakeGithub({ gists: [{ id: 'x', updated_at: T(1), files: { 'a.txt': '' } }] });
    assert.equal(await fake.client.findGist(), null);
    assert.equal(fake.state.calls.length, 1);

    const many = Array.from({ length: 700 }, (_, i) => ({ id: `g${i}`, updated_at: T(i), files: { 'a.txt': '' } }));
    const big = fakeGithub({ gists: many });
    assert.equal(await big.client.findGist(), null);
    assert.equal(big.state.calls.length, 5);
    assert.equal(big.state.calls.at(-1).search.get('page'), '5');
  });

  test('createGist posts a secret gist with the description and single file', async () => {
    const fake = fakeGithub();
    const created = await fake.client.createGist('{"hello":1}');
    assert.deepEqual(created, { id: 'gist1', updated_at: T(1001) });
    const post = fake.state.calls[0];
    assert.equal(post.method, 'POST');
    assert.equal(post.path, '/gists');
    assert.equal(post.headers['content-type'], 'application/json');
    assert.deepEqual(post.body, {
      description: 'Stand-Up Set Builder data',
      public: false,
      files: { [GIST_FILENAME]: { content: '{"hello":1}' } },
    });
  });

  test('readGist returns the file content and updated_at', async () => {
    const gist = gistWith(M.createWorkspace(), 'g');
    const fake = fakeGithub({ gists: [gist] });
    const r = await fake.client.readGist('g');
    assert.equal(r.updated_at, T(500));
    assert.equal(r.content, gist.files[GIST_FILENAME]);
    assert.equal(fake.state.calls.length, 1);
  });

  test('readGist of a truncated file fetches raw_url without Authorization and with cache no-store', async () => {
    const gist = gistWith(M.createWorkspace(), 'g');
    const fake = fakeGithub({ gists: [gist], truncate: true });
    const r = await fake.client.readGist('g');
    assert.equal(r.content, gist.files[GIST_FILENAME]);
    const [apiCall, rawCall] = fake.state.calls;
    assert.equal(apiCall.path, '/gists/g');
    assert.equal(rawCall.url, `${RAW_HOST}/alice/g/raw/${GIST_FILENAME}`);
    assert.equal(rawCall.headers.authorization, undefined);
    assert.equal(rawCall.init.cache, 'no-store');
  });

  test('readGist of a gist without the data file → notfound', async () => {
    const fake = fakeGithub({ gists: [{ id: 'g', updated_at: T(1), files: { 'other.txt': 'x' } }] });
    await assert.rejects(fake.client.readGist('g'), (e) => e instanceof SyncError && e.kind === 'notfound');
  });

  test('writeGist patches the file and returns updated_at', async () => {
    const fake = fakeGithub({ gists: [gistWith(M.createWorkspace(), 'g')] });
    const r = await fake.client.writeGist('g', 'new content');
    assert.deepEqual(r, { updated_at: T(1001) });
    const patch = fake.state.calls[0];
    assert.equal(patch.method, 'PATCH');
    assert.equal(patch.path, '/gists/g');
    assert.deepEqual(patch.body, { files: { [GIST_FILENAME]: { content: 'new content' } } });
    assert.equal(fake.state.gists.get('g').files[GIST_FILENAME], 'new content');
  });

  describe('error mapping', () => {
    async function errorOf(promise) {
      try {
        await promise;
      } catch (err) {
        assert.ok(err instanceof SyncError, `expected SyncError, got ${err}`);
        assert.equal(err.name, 'SyncError');
        return err;
      }
      assert.fail('expected a rejection');
    }

    test('fetch rejection → network', async () => {
      const boom = new TypeError('Failed to fetch');
      const client = createClient({ token: 't', fetch: async () => { throw boom; } });
      const err = await errorOf(client.whoami());
      assert.equal(err.kind, 'network');
      assert.equal(err.status, null);
      assert.equal(err.cause, boom);
    });

    test('synchronous TypeError from fetch → network', async () => {
      const client = createClient({ token: 't', fetch: () => { throw new TypeError('bad url'); } });
      assert.equal((await errorOf(client.findGist())).kind, 'network');
    });

    test('401 → auth', async () => {
      const client = createClient({ token: 't', fetch: async () => jsonResponse(401, { message: 'Bad credentials' }) });
      const err = await errorOf(client.whoami());
      assert.equal(err.kind, 'auth');
      assert.equal(err.status, 401);
    });

    test('403 on /gists → auth with the gist-scope message; elsewhere a plain auth error', async () => {
      const client = createClient({ token: 't', fetch: async () => jsonResponse(403, { message: 'Forbidden' }) });
      const onGists = await errorOf(client.findGist());
      assert.equal(onGists.kind, 'auth');
      assert.equal(onGists.message, GIST_SCOPE_MESSAGE);
      const onUser = await errorOf(client.whoami());
      assert.equal(onUser.kind, 'auth');
      assert.notEqual(onUser.message, GIST_SCOPE_MESSAGE);
    });

    test('404 → notfound (gist-scope message on /gists endpoints only)', async () => {
      const client = createClient({ token: 't', fetch: async () => jsonResponse(404, { message: 'Not Found' }) });
      const onGist = await errorOf(client.readGist('zzz'));
      assert.equal(onGist.kind, 'notfound');
      assert.equal(onGist.status, 404);
      assert.equal(onGist.message, GIST_SCOPE_MESSAGE);
      const onUser = await errorOf(client.whoami());
      assert.equal(onUser.kind, 'notfound');
      assert.notEqual(onUser.message, GIST_SCOPE_MESSAGE);
    });

    test('403 with x-ratelimit-remaining: 0 → ratelimit, retryAfterMs from x-ratelimit-reset (min 60 s)', async () => {
      const now = Date.UTC(2024, 0, 1);
      const resetSoon = Math.floor(now / 1000) + 5;
      const soon = createClient({
        token: 't',
        now: () => now,
        fetch: async () => jsonResponse(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSoon) }),
      });
      const err = await errorOf(soon.whoami());
      assert.equal(err.kind, 'ratelimit');
      assert.equal(err.status, 403);
      assert.equal(err.retryAfterMs, 60_000);

      const resetLater = Math.floor(now / 1000) + 600;
      const later = createClient({
        token: 't',
        now: () => now,
        fetch: async () => jsonResponse(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetLater) }),
      });
      assert.equal((await errorOf(later.findGist())).retryAfterMs, 600_000);
    });

    test('429 with retry-after seconds → ratelimit with retryAfterMs', async () => {
      const client = createClient({ token: 't', fetch: async () => jsonResponse(429, {}, { 'retry-after': '120' }) });
      const err = await errorOf(client.writeGist('g', 'x'));
      assert.equal(err.kind, 'ratelimit');
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterMs, 120_000);
      const tiny = createClient({ token: 't', fetch: async () => jsonResponse(429, {}, { 'retry-after': '1' }) });
      assert.equal((await errorOf(tiny.whoami())).retryAfterMs, 60_000);
    });

    test('other statuses → other', async () => {
      const client = createClient({ token: 't', fetch: async () => jsonResponse(500, { message: 'oops' }) });
      const err = await errorOf(client.whoami());
      assert.equal(err.kind, 'other');
      assert.equal(err.status, 500);
    });
  });
});

// ---------------------------------------------------------------------------
// merge

describe('merge', () => {
  test('identical inputs → nothing changed, no copies, inputs untouched', () => {
    const { ws } = seeded();
    const a = clone(ws);
    const b = clone(ws);
    const r = mergeBothWays(a, b);
    assert.equal(r.localChanged, false);
    assert.equal(r.remoteChanged, false);
    assert.deepEqual(r.conflictCopies, []);
    assert.equal(stable(r.workspace), stable(ws));
    assert.deepEqual(a, ws);
    assert.deepEqual(b, ws);
  });

  test('rule 1: tombstones are unioned keeping the later time', () => {
    const { ws } = seeded();
    const a = clone(ws);
    const b = clone(ws);
    a.tombstones = { x: T(10), y: T(5) };
    b.tombstones = { x: T(20), z: T(1) };
    const r = mergeBothWays(a, b);
    assert.deepEqual(r.workspace.tombstones, { x: T(20), y: T(5), z: T(1) });
  });

  test('rule 2: union by id; same id keeps the later updatedAt', () => {
    const { ws, jokeId } = seeded();
    const base = clone(ws);
    const synced = syncedMapOf(base);
    const a = clone(base);
    M.addVersion(a, { name: 'Only on A', fromVersionId: null });
    const b = clone(base);
    M.updateJoke(b, jokeId, { text: 'edited on B' });
    const r = mergeBothWays(a, b, { synced });
    assert.deepEqual(versionIds(r.workspace), [base.versions[0].id, a.versions[1].id].sort());
    assert.equal(byId(r.workspace, base.versions[0].id).topics[0].jokes[0].text, 'edited on B');
    assert.equal(r.localChanged, true);
    assert.equal(r.remoteChanged, true);
    assert.deepEqual(r.conflictCopies, []);
  });

  test('rule 2: equal updatedAt with different content → the stable JSON that sorts first wins', () => {
    const { ws } = seeded();
    const a = clone(ws);
    const b = clone(ws);
    a.versions[0].name = 'Zed';
    b.versions[0].name = 'Alpha';
    const r = mergeBothWays(a, b, { synced: syncedMapOf(ws) });
    assert.equal(r.workspace.versions.length, 1);
    assert.equal(r.workspace.versions[0].name, 'Alpha');
  });

  test('rule 2: a tombstone later than updatedAt deletes; an edit after the deletion resurrects', () => {
    const { ws, jokeId } = seeded();
    const base = clone(ws);
    const vId = base.versions[0].id;
    const synced = syncedMapOf(base);

    const deleter = clone(base);
    M.addVersion(deleter, { name: 'Keep', fromVersionId: null });
    M.deleteVersion(deleter, vId);
    const stale = clone(base); // never edited since the last sync
    const r = mergeBothWays(deleter, stale, { synced });
    assert.deepEqual(versionIds(r.workspace), [deleter.versions[0].id]);
    assert.deepEqual(r.conflictCopies, []);
    assert.equal(r.workspace.tombstones[vId], deleter.tombstones[vId]);

    const editor = clone(base);
    tick = 100; // the edit lands after the deletion
    M.updateJoke(editor, jokeId, { text: 'later edit' });
    const r2 = mergeBothWays(deleter, editor, { synced });
    assert.ok(byId(r2.workspace, vId), 'resurrected');
    assert.equal(byId(r2.workspace, vId).topics[0].jokes[0].text, 'later edit');
    assert.deepEqual(r2.conflictCopies, []);
  });

  test('rule 3a: both sides changed with different content → the loser survives as a conflict copy', () => {
    const { ws, jokeId, topicId } = seeded();
    const base = clone(ws);
    const synced = syncedMapOf(base);
    const a = clone(base);
    M.updateJoke(a, jokeId, { text: 'A text' });
    const b = clone(base);
    M.addJoke(b, topicId, { text: 'B joke' }); // lands after A's edit → B wins, A is the loser
    const aV = a.versions[0];
    const bV = b.versions[0];
    assert.ok(bV.updatedAt > aV.updatedAt);
    const r = mergeBothWays(a, b, { synced });

    const copyId = `${aV.id}~conflict~${aV.updatedAt}`;
    assert.deepEqual(r.conflictCopies, ['Set v1 (conflict copy)']);
    assert.deepEqual(versionIds(r.workspace), [bV.id, copyId].sort());
    assert.equal(stable(byId(r.workspace, bV.id)), stable(bV));
    assert.equal(byId(r.workspace, bV.id).topics[0].jokes[1].text, 'B joke');
    const copy = byId(r.workspace, copyId);
    assert.equal(copy.name, 'Set v1 (conflict copy)');
    assert.equal(copy.createdAt, aV.updatedAt);
    assert.equal(copy.updatedAt, aV.updatedAt);
    // Entity ids are remapped deterministically and carry the version's updatedAt (like the copy id)
    // so copies of the same version made at different times never share ids.
    const c = (id) => `${id}~c~${aV.updatedAt}`;
    assert.equal(copy.topics[0].id, c(topicId));
    assert.deepEqual(copy.topics[0].jokes.map((j) => j.id), [c(jokeId)]);
    assert.equal(copy.topics[0].jokes[0].text, 'A text');
    assert.deepEqual(copy.set.jokeIds, [c(jokeId)]);
    assert.equal(copy.set.updatedAt, aV.set.updatedAt);
    // Nothing else leaks: normalizing the merged workspace is a no-op (ids unique, shape valid).
    assert.equal(stable(M.normalize(clone(r.workspace))), stable(r.workspace));
  });

  test('rule 3a: conflict copy remaps alt ids and activeAltId', () => {
    const { ws, jokeId, topicId } = seeded();
    const altId = M.addAlt(ws, jokeId, { text: 'alt' });
    M.setActiveAlt(ws, jokeId, altId);
    const base = clone(ws);
    const synced = syncedMapOf(base);
    const a = clone(base);
    M.updateJoke(a, jokeId, { text: 'A' });
    const b = clone(base);
    M.addTopic(b, { title: 'B topic' });
    const r = mergeBothWays(a, b, { synced });
    const copy = r.workspace.versions.find((v) => v.id.includes('~conflict~'));
    assert.ok(copy);
    const c = (id) => `${id}~c~${a.versions[0].updatedAt}`;
    assert.equal(copy.topics[0].id, c(topicId));
    assert.equal(copy.topics[0].jokes[0].alts[0].id, c(altId));
    assert.equal(copy.topics[0].jokes[0].activeAltId, c(altId));
  });

  test('rule 3a: only one side changed → plain last-writer-wins, no copy', () => {
    const { ws, jokeId } = seeded();
    const base = clone(ws);
    const synced = syncedMapOf(base);
    const a = clone(base);
    const b = clone(base);
    M.updateJoke(b, jokeId, { text: 'B text' });
    const r = mergeBothWays(a, b, { synced });
    assert.deepEqual(r.conflictCopies, []);
    assert.equal(r.workspace.versions.length, 1);
    assert.equal(r.workspace.versions[0].topics[0].jokes[0].text, 'B text');
  });

  test('rule 3a: both changed but same content (e.g. rename on both) → no copy', () => {
    const { ws } = seeded();
    const base = clone(ws);
    const synced = syncedMapOf(base);
    const a = clone(base);
    M.renameVersion(a, a.versions[0].id, 'A name');
    const b = clone(base);
    M.renameVersion(b, b.versions[0].id, 'B name');
    const r = mergeBothWays(a, b, { synced });
    assert.deepEqual(r.conflictCopies, []);
    assert.equal(r.workspace.versions.length, 1);
    assert.equal(r.workspace.versions[0].name, 'B name');
  });

  test('rule 3b: tombstone vs an unsynced edit → the edit survives as a conflict copy', () => {
    const { ws, jokeId } = seeded();
    const base = clone(ws);
    const vId = base.versions[0].id;
    const synced = syncedMapOf(base);
    const editor = clone(base);
    M.updateJoke(editor, jokeId, { text: 'unsynced edit' }); // t = 6
    const deleter = clone(base);
    M.addVersion(deleter, { name: 'Keep', fromVersionId: null });
    M.deleteVersion(deleter, vId); // t = 10 > 6
    const editedV = editor.versions[0];
    const r = mergeBothWays(deleter, editor, { synced });
    assert.deepEqual(r.conflictCopies, ['Set v1 (conflict copy)']);
    assert.deepEqual(versionIds(r.workspace), [deleter.versions[0].id, `${vId}~conflict~${editedV.updatedAt}`].sort());
    const copy = byId(r.workspace, `${vId}~conflict~${editedV.updatedAt}`);
    assert.equal(copy.topics[0].jokes[0].text, 'unsynced edit');
    assert.equal(r.workspace.tombstones[vId], deleter.tombstones[vId]);
  });

  test('retry: merging again (local already holds the copy, remote unchanged) creates no duplicate', () => {
    const { ws, jokeId, topicId } = seeded();
    const base = clone(ws);
    const synced = syncedMapOf(base);
    const a = clone(base);
    M.updateJoke(a, jokeId, { text: 'A text' });
    const b = clone(base);
    M.addJoke(b, topicId, { text: 'B joke' });
    const first = merge(a, b, { synced });
    assert.equal(first.conflictCopies.length, 1);

    // Same inputs again (write failed, nothing stored) → identical result.
    const again = merge(a, b, { synced });
    assert.equal(stable(again.workspace), stable(first.workspace));

    // Local adopted the merged result, remote still old → copy is recognised, not re-created.
    const second = mergeBothWays(first.workspace, b, { synced });
    assert.deepEqual(second.conflictCopies, []);
    assert.deepEqual(versionIds(second.workspace), versionIds(first.workspace));
    assert.equal(second.localChanged, false);
    assert.equal(second.remoteChanged, true);
  });

  test('a copy whose id already exists on either side is not created again', () => {
    const { ws, jokeId, topicId } = seeded();
    const base = clone(ws);
    const synced = syncedMapOf(base);
    const a = clone(base);
    M.updateJoke(a, jokeId, { text: 'A text' });
    const b = clone(base);
    M.addJoke(b, topicId, { text: 'B joke' }); // B wins; the copy would be of A's version
    const aV = a.versions[0];
    const copyId = `${aV.id}~conflict~${aV.updatedAt}`;
    b.versions.push({ ...clone(aV), id: copyId, name: 'already here', createdAt: aV.updatedAt });
    const r = mergeBothWays(a, b, { synced });
    assert.deepEqual(r.conflictCopies, []);
    assert.equal(byId(r.workspace, copyId).name, 'already here');
  });

  test('a conflict copy the user already deleted is not resurrected', () => {
    const { ws, jokeId, topicId } = seeded();
    const base = clone(ws);
    const synced = syncedMapOf(base);
    const a = clone(base);
    M.updateJoke(a, jokeId, { text: 'A text' });
    const b = clone(base);
    M.addJoke(b, topicId, { text: 'B joke' }); // B wins; the copy would be of A's version
    const aV = a.versions[0];
    b.tombstones[`${aV.id}~conflict~${aV.updatedAt}`] = T(999);
    const r = mergeBothWays(a, b, { synced });
    assert.deepEqual(r.conflictCopies, []);
    assert.equal(r.workspace.versions.length, 1);
  });

  test('remote clock ahead: a deletion newer than a fully synced edit → no spurious copy', () => {
    const { ws, jokeId } = seeded();
    const edited = clone(ws);
    M.updateJoke(edited, jokeId, { text: 'synced edit' });
    const vId = edited.versions[0].id;
    const synced = syncedMapOf(edited); // this edit was reconciled with the gist
    const remote = clone(edited);
    tick = 5000; // the other device's clock runs far ahead
    M.addVersion(remote, { name: 'Keep', fromVersionId: null });
    M.deleteVersion(remote, vId);
    const r = mergeBothWays(edited, remote, { synced });
    assert.deepEqual(r.conflictCopies, []);
    assert.deepEqual(versionIds(r.workspace), [remote.versions[0].id]);
  });

  test('local clock behind: an unsynced edit older than the deletion is not lost', () => {
    const { ws, jokeId } = seeded();
    const base = clone(ws);
    const vId = base.versions[0].id;
    const synced = syncedMapOf(base);
    const remote = clone(base);
    tick = 5000;
    M.addVersion(remote, { name: 'Keep', fromVersionId: null });
    M.deleteVersion(remote, vId);
    const local = clone(base);
    tick = 10; // this device's clock is behind the deleter's
    M.updateJoke(local, jokeId, { text: 'late edit' });
    const r = mergeBothWays(local, remote, { synced });
    assert.equal(r.conflictCopies.length, 1);
    const copy = r.workspace.versions.find((v) => v.id.startsWith(`${vId}~conflict~`));
    assert.equal(copy.topics[0].jokes[0].text, 'late edit');
    assert.ok(!byId(r.workspace, vId), 'the original stays deleted');
  });

  test('rule 4: later settingsUpdatedAt wins; tie → local', () => {
    const { ws } = seeded();
    const a = clone(ws);
    const b = clone(ws);
    M.updateSettings(b, { wpm: 200 });
    assert.equal(merge(a, b).workspace.settings.wpm, 200);
    assert.equal(merge(b, a).workspace.settings.wpm, 200);
    assert.equal(merge(a, b).workspace.settingsUpdatedAt, b.settingsUpdatedAt);

    const c = clone(ws);
    c.settings = { ...c.settings, wpm: 99 }; // same timestamp, different value
    assert.equal(merge(a, c).workspace.settings.wpm, 140);
    assert.equal(merge(c, a).workspace.settings.wpm, 99);
  });

  test('rule 5: activeVersionId prefers local, then remote, then the first version', () => {
    const { ws } = seeded();
    const base = clone(ws);
    const a = clone(base);
    const aNew = M.addVersion(a, { name: 'A2', fromVersionId: null });
    const b = clone(base);
    const bNew = M.addVersion(b, { name: 'B2', fromVersionId: null });
    assert.equal(merge(a, b).workspace.activeVersionId, aNew);
    assert.equal(merge(b, a).workspace.activeVersionId, bNew);

    const synced = syncedMapOf(a);
    const c = clone(a);
    M.deleteVersion(c, aNew); // local's active version is gone on c
    assert.equal(merge(a, c, { synced }).workspace.activeVersionId, base.versions[0].id);

    // Neither active id survives: local active deleted by remote, remote active deleted by local.
    const d = clone(a);
    tick = 1000;
    M.addVersion(d, { name: 'D3', fromVersionId: null });
    M.deleteVersion(d, aNew);
    M.switchVersion(d, base.versions[0].id);
    const e = clone(a);
    tick = 2000;
    M.deleteVersion(e, base.versions[0].id); // e active = aNew
    const r = merge(d, e, { synced: syncedMapOf(a) });
    assert.deepEqual(versionIds(r.workspace), [d.versions.find((v) => v.name === 'D3').id]);
    assert.equal(r.workspace.activeVersionId, r.workspace.versions[0].id);
  });

  test('rule 6: versions ordered by (createdAt, id); updatedAt is the max; id and schemaVersion from local', () => {
    const { ws } = seeded();
    const a = clone(ws);
    const b = clone(ws);
    b.id = 'remote-ws';
    tick = 50;
    M.addVersion(b, { name: 'Later', fromVersionId: null });
    tick = 20;
    M.addVersion(a, { name: 'Earlier', fromVersionId: null });
    const r = mergeBothWays(a, b);
    assert.deepEqual(r.workspace.versions.map((v) => v.name), ['Set v1', 'Earlier', 'Later']);
    assert.equal(r.workspace.updatedAt, b.updatedAt);
    assert.equal(r.workspace.id, a.id);
    assert.equal(r.workspace.schemaVersion, 1);
    assert.equal(merge(b, a).workspace.id, 'remote-ws');
  });

  test('rule 7: localChanged / remoteChanged reflect which side differs from the result', () => {
    const { ws, jokeId } = seeded();
    const base = clone(ws);
    const synced = syncedMapOf(base);
    const edited = clone(base);
    M.updateJoke(edited, jokeId, { text: 'new' });
    const pull = merge(base, edited, { synced });
    assert.equal(pull.localChanged, true);
    assert.equal(pull.remoteChanged, false);
    const push = merge(edited, base, { synced });
    assert.equal(push.localChanged, false);
    assert.equal(push.remoteChanged, true);
  });

  test('cross-deletions that would empty the workspace resurrect the latest casualty', () => {
    const { ws } = seeded();
    const base = clone(ws);
    const v1 = base.versions[0].id;
    const v2 = M.addVersion(base, { name: 'Two', fromVersionId: null });
    const synced = syncedMapOf(base);
    const a = clone(base);
    M.deleteVersion(a, v1);
    const b = clone(base);
    M.deleteVersion(b, v2);
    const r = mergeBothWays(a, b, { synced });
    assert.equal(r.workspace.versions.length, 1);
    const [survivor] = r.workspace.versions;
    assert.equal(survivor.id, v2); // the later-updated of the two
    assert.equal(r.workspace.tombstones[v2], undefined);
    assert.equal(r.workspace.tombstones[v1], a.tombstones[v1]);
    assert.equal(r.workspace.activeVersionId, v2);
  });

  test('unknown synced ids count as changed (import merge with synced: {} keeps both diverged versions)', () => {
    const { ws, jokeId, topicId } = seeded();
    const a = clone(ws);
    M.updateJoke(a, jokeId, { text: 'mine' });
    const b = clone(ws);
    M.addJoke(b, topicId, { text: 'theirs' });
    const r = mergeBothWays(a, b);
    assert.equal(r.conflictCopies.length, 1);
    assert.equal(r.workspace.versions.length, 2);
  });
});

// ---------------------------------------------------------------------------
// runSync

describe('runSync', () => {
  test('first time: no gist anywhere → creates one with the export envelope', async () => {
    const fake = fakeGithub();
    const { ws } = seeded();
    const r = await runSync({ client: fake.client, workspace: ws });
    assert.equal(r.gistId, 'gist1');
    assert.equal(r.pushed, true);
    assert.equal(r.pulled, false);
    assert.equal(r.localChanged, false);
    assert.equal(r.remoteChanged, true);
    assert.deepEqual(r.conflictCopies, []);
    assert.equal(r.remoteUpdatedAt, T(1001));
    assert.deepEqual(r.synced, syncedMapOf(ws));
    assert.equal(r.workspace, ws);
    const stored = JSON.parse(fake.state.gists.get('gist1').files[GIST_FILENAME]);
    assert.equal(stored.app, 'standup-set-builder');
    assert.equal(stable(stored.workspace), stable(ws));
    assert.deepEqual(fake.state.calls.map((c) => `${c.method} ${c.path}`), ['GET /gists', 'POST /gists']);
  });

  test('gistId null but a gist exists → finds it and syncs with it', async () => {
    const { ws } = seeded();
    const fake = fakeGithub({ gists: [gistWith(ws, 'found')] });
    const r = await runSync({ client: fake.client, workspace: clone(ws), synced: syncedMapOf(ws) });
    assert.equal(r.gistId, 'found');
    assert.equal(r.pushed, false);
    assert.equal(r.pulled, false);
    assert.equal(r.remoteUpdatedAt, T(500));
    assert.deepEqual(fake.state.calls.map((c) => `${c.method} ${c.path}`), ['GET /gists', 'GET /gists/found']);
  });

  test('pristine adoption: an empty local workspace with no synced map adopts the remote', async () => {
    const { ws: remote } = seeded();
    const fake = fakeGithub({ gists: [gistWith(remote, 'g')] });
    const local = M.createWorkspace();
    const r = await runSync({ client: fake.client, workspace: local, gistId: 'g' });
    assert.equal(stable(r.workspace), stable(remote));
    assert.equal(r.localChanged, true);
    assert.equal(r.remoteChanged, false);
    assert.equal(r.pulled, true);
    assert.equal(r.pushed, false);
    assert.equal(r.workspace.versions.length, 1);
    assert.deepEqual(r.synced, syncedMapOf(remote));
    assert.ok(!fake.state.calls.some((c) => c.method === 'PATCH'), 'nothing written');
  });

  test('no pristine adoption when synced is non-empty or the local workspace has content', async () => {
    const { ws: remote } = seeded();
    const fake = fakeGithub({ gists: [gistWith(remote, 'g')] });
    const local = M.createWorkspace();
    const r = await runSync({ client: fake.client, workspace: local, gistId: 'g', synced: { old: T(1) } });
    assert.equal(r.workspace.versions.length, 2, 'merged instead of adopted');
    assert.equal(r.pushed, true);

    const fake2 = fakeGithub({ gists: [gistWith(remote, 'g')] });
    const { ws: localWithContent } = seeded({ title: 'Dogs' });
    const r2 = await runSync({ client: fake2.client, workspace: localWithContent, gistId: 'g' });
    assert.equal(r2.workspace.versions.length, 2);
  });

  test('pull: remote edits come down without a write', async () => {
    const { ws, jokeId } = seeded();
    const base = clone(ws);
    const remote = clone(base);
    M.updateJoke(remote, jokeId, { text: 'from remote' });
    const fake = fakeGithub({ gists: [gistWith(remote, 'g')] });
    const r = await runSync({ client: fake.client, workspace: base, gistId: 'g', synced: syncedMapOf(base) });
    assert.equal(r.pulled, true);
    assert.equal(r.pushed, false);
    assert.equal(r.workspace.versions[0].topics[0].jokes[0].text, 'from remote');
    assert.equal(r.remoteUpdatedAt, T(500));
    assert.deepEqual(r.synced, syncedMapOf(remote));
    assert.ok(!fake.state.calls.some((c) => c.method === 'PATCH'));
  });

  test('push: local edits are written; synced reflects the merged workspace', async () => {
    const { ws, jokeId } = seeded();
    const base = clone(ws);
    const local = clone(base);
    M.updateJoke(local, jokeId, { text: 'from local' });
    const fake = fakeGithub({ gists: [gistWith(base, 'g')] });
    const r = await runSync({ client: fake.client, workspace: local, gistId: 'g', synced: syncedMapOf(base) });
    assert.equal(r.pushed, true);
    assert.equal(r.pulled, false);
    assert.equal(r.localChanged, false);
    assert.equal(r.remoteUpdatedAt, T(1001));
    assert.deepEqual(r.synced, syncedMapOf(local));
    assert.equal(remoteWorkspace(fake, 'g').versions[0].topics[0].jokes[0].text, 'from local');
  });

  test('both sides changed → merged result pulled and pushed, conflict copies reported', async () => {
    const { ws, jokeId, topicId } = seeded();
    const base = clone(ws);
    const local = clone(base);
    M.updateJoke(local, jokeId, { text: 'local text' });
    const remote = clone(base);
    M.addJoke(remote, topicId, { text: 'remote joke' });
    const fake = fakeGithub({ gists: [gistWith(remote, 'g')] });
    const r = await runSync({ client: fake.client, workspace: local, gistId: 'g', synced: syncedMapOf(base) });
    assert.equal(r.pushed, true);
    assert.equal(r.pulled, true);
    assert.deepEqual(r.conflictCopies, ['Set v1 (conflict copy)']);
    assert.equal(r.workspace.versions.length, 2);
    assert.equal(stable(remoteWorkspace(fake, 'g')), stable(r.workspace));
    assert.deepEqual(r.synced, syncedMapOf(r.workspace));
  });

  test('notfound recovery: a stale gistId falls back to findGist and then the existing gist', async () => {
    const { ws } = seeded();
    const fake = fakeGithub({ gists: [gistWith(ws, 'real')] });
    const r = await runSync({ client: fake.client, workspace: clone(ws), gistId: 'gone', synced: syncedMapOf(ws) });
    assert.equal(r.gistId, 'real');
    assert.deepEqual(fake.state.calls.map((c) => `${c.method} ${c.path}`), ['GET /gists/gone', 'GET /gists', 'GET /gists/real']);
  });

  test('notfound recovery: nothing to find → creates a fresh gist', async () => {
    const { ws } = seeded();
    const fake = fakeGithub();
    const r = await runSync({ client: fake.client, workspace: ws, gistId: 'gone', synced: syncedMapOf(ws) });
    assert.equal(r.gistId, 'gist1');
    assert.equal(r.pushed, true);
    assert.deepEqual(fake.state.calls.map((c) => `${c.method} ${c.path}`), ['GET /gists/gone', 'GET /gists', 'POST /gists']);
  });

  test('notfound on write also recovers once', async () => {
    const { ws, jokeId } = seeded();
    const base = clone(ws);
    const local = clone(base);
    M.updateJoke(local, jokeId, { text: 'edit' });
    const fake = fakeGithub({ gists: [gistWith(base, 'g')] });
    let patches = 0;
    fake.state.respond = (method, path) => {
      if (method === 'PATCH' && path === '/gists/g' && patches++ === 0) {
        fake.state.gists.delete('g'); // deleted on GitHub between read and write
        return jsonResponse(404, { message: 'Not Found' });
      }
      return undefined;
    };
    const r = await runSync({ client: fake.client, workspace: local, gistId: 'g', synced: syncedMapOf(base) });
    assert.equal(r.gistId, 'gist1');
    assert.equal(r.pushed, true);
    assert.deepEqual(fake.state.calls.map((c) => `${c.method} ${c.path}`), ['GET /gists/g', 'PATCH /gists/g', 'GET /gists', 'POST /gists']);
  });

  test('a second notfound in the same run propagates', async () => {
    const { ws } = seeded();
    const fake = fakeGithub({ gists: [gistWith(ws, 'g')] });
    fake.state.respond = (method, path) => (method === 'GET' && path.startsWith('/gists/') ? jsonResponse(404, {}) : undefined);
    await assert.rejects(
      runSync({ client: fake.client, workspace: clone(ws), gistId: 'g', synced: syncedMapOf(ws) }),
      (e) => e instanceof SyncError && e.kind === 'notfound',
    );
    assert.deepEqual(fake.state.calls.map((c) => `${c.method} ${c.path}`), ['GET /gists/g', 'GET /gists', 'GET /gists/g']);
  });

  test('unreadable remote → SyncError(other, "Remote data is unreadable") and no write', async () => {
    const { ws } = seeded();
    for (const content of ['not json', '{"app":"x"}', '[]', '']) {
      const fake = fakeGithub({ gists: [{ id: 'g', updated_at: T(1), files: { [GIST_FILENAME]: content } }] });
      await assert.rejects(
        runSync({ client: fake.client, workspace: clone(ws), gistId: 'g' }),
        (e) => e instanceof SyncError && e.kind === 'other' && e.message === UNREADABLE_REMOTE_MESSAGE,
      );
      assert.ok(!fake.state.calls.some((c) => c.method === 'PATCH' || c.method === 'POST'));
      assert.equal(fake.state.gists.get('g').files[GIST_FILENAME], content);
    }
  });

  test('a truncated remote file is read through raw_url', async () => {
    const { ws: remote, jokeId } = seeded();
    const base = clone(remote);
    M.updateJoke(remote, jokeId, { text: 'long remote text' });
    const fake = fakeGithub({ gists: [gistWith(remote, 'g')], truncate: true });
    const r = await runSync({ client: fake.client, workspace: base, gistId: 'g', synced: syncedMapOf(base) });
    assert.equal(r.workspace.versions[0].topics[0].jokes[0].text, 'long remote text');
  });

  test('client errors propagate unchanged (auth) and nothing is written', async () => {
    const { ws } = seeded();
    const fake = fakeGithub({ gists: [gistWith(ws, 'g')] });
    const client = createClient({ token: 'ghp_x', fetch: async () => jsonResponse(401, {}) });
    await assert.rejects(runSync({ client, workspace: ws, gistId: 'g' }), (e) => e.kind === 'auth');
    const offline = createClient({ token: 'ghp_x', fetch: async () => { throw new TypeError('offline'); } });
    await assert.rejects(runSync({ client: offline, workspace: ws }), (e) => e.kind === 'network');
  });

  test('a failed write rejects so the caller keeps its old synced map', async () => {
    const { ws, jokeId } = seeded();
    const base = clone(ws);
    const local = clone(base);
    M.updateJoke(local, jokeId, { text: 'edit' });
    const fake = fakeGithub({ gists: [gistWith(base, 'g')] });
    fake.state.respond = (method) => (method === 'PATCH' ? jsonResponse(500, {}) : undefined);
    await assert.rejects(
      runSync({ client: fake.client, workspace: local, gistId: 'g', synced: syncedMapOf(base) }),
      (e) => e instanceof SyncError && e.kind === 'other' && e.status === 500,
    );
  });
});

describe('syncedMapOf', () => {
  test('maps every version id to its updatedAt', () => {
    const { ws } = seeded();
    const v2 = M.addVersion(ws, { name: 'Two', fromVersionId: null });
    assert.deepEqual(syncedMapOf(ws), {
      [ws.versions[0].id]: ws.versions[0].updatedAt,
      [v2]: byId(ws, v2).updatedAt,
    });
    assert.deepEqual(syncedMapOf({}), {});
  });
});

// ---------------------------------------------------------------------------
// Regressions and property checks

describe('merge regressions', () => {
  /** Every topic/joke/alt id in the workspace. */
  function entityIds(ws) {
    const ids = [];
    for (const v of ws.versions) {
      for (const t of v.topics) {
        ids.push(t.id);
        for (const j of t.jokes) {
          ids.push(j.id);
          for (const a of j.alts) ids.push(a.id);
        }
      }
    }
    return ids;
  }

  test('a second conflict on the same version while the first copy still exists keeps every entity id unique', () => {
    const { ws, jokeId } = seeded();
    const altId = M.addAlt(ws, jokeId, { text: 'alt' });
    M.setActiveAlt(ws, jokeId, altId);
    const synced1 = syncedMapOf(ws);
    const a1 = clone(ws);
    M.updateJoke(a1, jokeId, { text: 'A1' });
    const b1 = clone(ws);
    M.updateJoke(b1, jokeId, { text: 'B1' });
    const first = mergeBothWays(a1, b1, { synced: synced1 });
    assert.equal(first.conflictCopies.length, 1);

    // Both devices adopted the first merge (copy included) and diverge again on the original version.
    const synced2 = syncedMapOf(first.workspace);
    const a2 = clone(first.workspace);
    M.updateJoke(a2, jokeId, { text: 'A2' });
    const b2 = clone(first.workspace);
    M.updateJoke(b2, jokeId, { text: 'B2' });
    const second = mergeBothWays(a2, b2, { synced: synced2 });
    assert.equal(second.conflictCopies.length, 1);
    assert.equal(second.workspace.versions.length, 3);

    const ids = entityIds(second.workspace);
    assert.equal(new Set(ids).size, ids.length, 'entity ids unique across the whole workspace');
    const copies = second.workspace.versions.filter((v) => v.id.includes('~conflict~'));
    for (const copy of copies) {
      assert.equal(copy.set.jokeIds.length, 1, 'each copy keeps its set');
      assert.equal(copy.topics[0].jokes[0].activeAltId, copy.topics[0].jokes[0].alts[0].id, 'each copy keeps its active alt');
    }
    // normalize (which the store applies on adoption) must not have to repair anything.
    assert.equal(stable(M.normalize(clone(second.workspace))), stable(second.workspace));
    // A retry of the same merge unions cleanly.
    const retry = mergeBothWays(second.workspace, b2, { synced: synced2 });
    assert.deepEqual(retry.conflictCopies, []);
    assert.equal(stable(retry.workspace), stable(second.workspace));
  });

  test('property: random divergent histories merge symmetrically, keep ids unique and survive normalize and retries', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 20240101;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    setClock(() => new Date(Date.UTC(2024, 0, 1) + (tick += 1 + Math.floor(rnd() * 3)) * 1000));

    function randomEdit(target) {
      const version = M.activeVersion(target);
      const jokes = version.topics.flatMap((t) => t.jokes);
      switch (pick(['topic', 'joke', 'edit', 'toggle', 'alt', 'version', 'delete', 'rename', 'switch', 'remove', 'settings'])) {
        case 'topic': M.addTopic(target, { title: `t${idCounter}` }); break;
        case 'joke': if (version.topics.length) M.addJoke(target, pick(version.topics).id, { text: `joke ${idCounter}` }); break;
        case 'edit': if (jokes.length) M.updateJoke(target, pick(jokes).id, { text: `edited ${idCounter}` }); break;
        case 'toggle': if (jokes.length) M.toggleInSet(target, pick(jokes).id); break;
        case 'alt': if (jokes.length) { const j = pick(jokes).id; M.setActiveAlt(target, j, M.addAlt(target, j, { text: 'alt' })); } break;
        case 'version': M.addVersion(target, { fromVersionId: rnd() < 0.5 ? null : target.activeVersionId }); break;
        case 'delete': if (target.versions.length > 1) M.deleteVersion(target, pick(target.versions).id); break;
        case 'rename': M.renameVersion(target, pick(target.versions).id, `n${idCounter}`); break;
        case 'switch': M.switchVersion(target, pick(target.versions).id); break;
        case 'remove': if (jokes.length) M.removeJoke(target, pick(jokes).id); break;
        case 'settings': M.updateSettings(target, { wpm: 60 + Math.floor(rnd() * 200) }); break;
        default: break;
      }
    }
    const diverge = (base, synced) => {
      const a = clone(base);
      const b = clone(base);
      for (let k = Math.floor(rnd() * 6); k > 0; k--) randomEdit(a);
      for (let k = Math.floor(rnd() * 6); k > 0; k--) randomEdit(b);
      return check(a, b, synced);
    };
    const check = (a, b, synced) => {
      const r = mergeBothWays(a, b, { synced });
      const ids = entityIds(r.workspace);
      assert.equal(new Set(ids).size, ids.length, 'entity ids unique');
      assert.equal(stable(M.normalize(clone(r.workspace))), stable(r.workspace), 'normalize is a no-op on a merge result');
      assert.ok(r.workspace.versions.some((v) => v.id === r.workspace.activeVersionId), 'active version exists');
      const retry = merge(r.workspace, b, { synced });
      assert.deepEqual(retry.conflictCopies, [], 'a retry creates no new copies');
      assert.equal(stable(retry.workspace.versions), stable(r.workspace.versions), 'a retry keeps the version set');
      return r;
    };

    for (let i = 0; i < 150; i++) {
      const base = M.createWorkspace();
      for (let k = 0; k < 8; k++) randomEdit(base);
      const synced = rnd() < 0.2 ? {} : syncedMapOf(base);
      const first = diverge(base, synced);
      // Second round from the merged state, so earlier conflict copies coexist with new ones.
      diverge(first.workspace, syncedMapOf(first.workspace));
    }
  });
});
