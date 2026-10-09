// Exercises tests/e2e/fakeGithub.js through a hand-rolled Playwright-like `route` object so the
// fake's contract (the one js/sync.js relies on) is verified without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGithub, install, API_ORIGIN } from '../e2e/fakeGithub.js';

/** Sends one request through `fake.handler` and returns { status, headers, json }. */
async function call(fake, method, path, { token = 'ghp_good', body = undefined, headers = {} } = {}) {
  let result;
  const route = {
    request: () => ({
      method: () => method,
      url: () => `${API_ORIGIN}${path}`,
      headers: () => ({
        accept: 'application/vnd.github+json',
        ...(token == null ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      }),
      postDataJSON: () => {
        if (body === undefined) throw new Error('no post data');
        return body;
      },
    }),
    fulfill: async (res) => { result = res; },
  };
  await fake.handler(route);
  return { status: result.status, headers: result.headers, json: JSON.parse(result.body) };
}

test('GET /user returns the login and the gist scope header', async () => {
  const fake = createFakeGithub({ login: 'alice' });
  const r = await call(fake, 'GET', '/user');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { login: 'alice' });
  assert.equal(r.headers['X-OAuth-Scopes'], 'gist');
  assert.match(r.headers['content-type'], /application\/json/);
});

test('401 without Authorization, with a non-Bearer header, or with a token containing "bad"', async () => {
  const fake = createFakeGithub();
  assert.equal((await call(fake, 'GET', '/user', { token: null })).status, 401);
  assert.equal((await call(fake, 'GET', '/user', { token: null, headers: { authorization: 'token abc' } })).status, 401);
  assert.equal((await call(fake, 'GET', '/user', { token: 'very-bad-token' })).status, 401);
  assert.equal((await call(fake, 'GET', '/gists?per_page=100&page=1', { token: 'bad' })).status, 401);
  // Header lookup is case-insensitive (Playwright lowercases, hand-written tests may not).
  const r = await call(fake, 'GET', '/user', { token: null, headers: { Authorization: 'Bearer ok' } });
  assert.equal(r.status, 200);
});

test('gist lifecycle: list empty → create → list/read → patch → read', async () => {
  const fake = createFakeGithub({ login: 'tester' });
  const empty = await call(fake, 'GET', '/gists?per_page=100&page=1');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, []);

  const created = await call(fake, 'POST', '/gists', {
    body: { description: 'Stand-Up Set Builder data', public: false, files: { 'standup-set-builder.json': { content: '{"a":1}' } } },
  });
  assert.equal(created.status, 201);
  const id = created.json.id;
  assert.ok(id && typeof id === 'string');
  assert.equal(created.json.public, false);
  assert.equal(created.json.description, 'Stand-Up Set Builder data');
  assert.equal(created.json.files['standup-set-builder.json'].content, '{"a":1}');
  assert.equal(fake.state.gists.size, 1);

  const list = await call(fake, 'GET', '/gists?per_page=100&page=1');
  assert.equal(list.json.length, 1);
  const item = list.json[0];
  assert.equal(item.id, id);
  assert.equal(item.updated_at, created.json.updated_at);
  const meta = item.files['standup-set-builder.json'];
  assert.equal(meta.filename, 'standup-set-builder.json');
  assert.equal(meta.truncated, false);
  assert.equal(meta.size, 7);
  assert.match(meta.raw_url, /^https:\/\/gist\.githubusercontent\.com\/tester\//);
  assert.equal('content' in meta, false, 'list items carry no content, like GitHub');

  const page2 = await call(fake, 'GET', '/gists?per_page=100&page=2');
  assert.deepEqual(page2.json, []);

  const read = await call(fake, 'GET', `/gists/${id}`);
  assert.equal(read.status, 200);
  assert.equal(read.json.files['standup-set-builder.json'].content, '{"a":1}');
  assert.equal(read.json.files['standup-set-builder.json'].truncated, false);

  const patched = await call(fake, 'PATCH', `/gists/${id}`, {
    body: { files: { 'standup-set-builder.json': { content: '{"a":2}' } } },
  });
  assert.equal(patched.status, 200);
  assert.ok(patched.json.updated_at > created.json.updated_at, 'updated_at advances on write');
  const reread = await call(fake, 'GET', `/gists/${id}`);
  assert.equal(reread.json.files['standup-set-builder.json'].content, '{"a":2}');
  assert.equal(reread.json.updated_at, patched.json.updated_at);
});

test('unknown gist id → 404 on read and patch; unknown routes → 404', async () => {
  const fake = createFakeGithub();
  assert.equal((await call(fake, 'GET', '/gists/nope')).status, 404);
  assert.equal((await call(fake, 'PATCH', '/gists/nope', { body: { files: {} } })).status, 404);
  assert.equal((await call(fake, 'GET', '/repos/x/y')).status, 404);
});

test('listing is ordered by updated_at descending and paginated by per_page', async () => {
  const fake = createFakeGithub();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await call(fake, 'POST', '/gists', { body: { files: { [`f${i}.txt`]: { content: String(i) } } } });
    ids.push(r.json.id);
  }
  await call(fake, 'PATCH', `/gists/${ids[0]}`, { body: { files: { 'f0.txt': { content: 'x' } } } });
  const all = (await call(fake, 'GET', '/gists?per_page=100&page=1')).json.map((g) => g.id);
  assert.deepEqual(all, [ids[0], ids[2], ids[1]]);
  const p1 = (await call(fake, 'GET', '/gists?per_page=2&page=1')).json.map((g) => g.id);
  const p2 = (await call(fake, 'GET', '/gists?per_page=2&page=2')).json.map((g) => g.id);
  assert.deepEqual(p1, [ids[0], ids[2]]);
  assert.deepEqual(p2, [ids[1]]);
});

test('a shared fake instance lets two "devices" see the same gist', async () => {
  const fake = createFakeGithub();
  const created = await call(fake, 'POST', '/gists', { body: { files: { 'standup-set-builder.json': { content: 'A' } } } });
  const other = await call(fake, 'GET', '/gists?per_page=100&page=1', { token: 'ghp_other_device' });
  assert.equal(other.json[0].id, created.json.id);
});

test('install() routes api.github.com through the fake handler', async () => {
  const fake = createFakeGithub();
  const calls = [];
  const context = { route: async (pattern, handler) => { calls.push([pattern, handler]); } };
  await install(context, fake);
  assert.deepEqual(calls, [['https://api.github.com/**', fake.handler]]);
});
