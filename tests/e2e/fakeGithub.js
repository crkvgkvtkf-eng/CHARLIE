// In-memory fake of the GitHub Gist REST API for Playwright `page.route` (SPEC §13.1).
// One `createFakeGithub()` instance can be installed into several browser contexts so two
// "devices" sync through the same gist. It implements only what js/sync.js uses:
//   GET  /user                       → 200 { login }, header X-OAuth-Scopes: gist
//   GET  /gists?per_page=N&page=M    → array of gist summaries (files without `content`)
//   POST /gists                      → 201 full gist
//   GET  /gists/:id                  → 200 full gist (files with `content`), 404 when unknown
//   PATCH /gists/:id                 → 200 full gist, 404 when unknown
// Every request needs `Authorization: Bearer <token>`; a missing/malformed header or a token
// containing "bad" yields 401 (so a test can exercise the auth-error path with the token "bad-token").

export const API_ORIGIN = 'https://api.github.com';

/** Pure dispatcher: turns a parsed request into { status, headers, body } against `state`. */
function respond(state, login, { method, url, headers, json }) {
  const auth = headerOf(headers, 'authorization');
  const token = auth && auth.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token || token.includes('bad')) return reply(401, { message: 'Bad credentials' });

  const { pathname, searchParams } = new URL(url);
  const path = pathname.replace(/\/+$/, '');

  if (method === 'GET' && path === '/user') {
    return reply(200, { login }, { 'X-OAuth-Scopes': 'gist' });
  }

  if (path === '/gists') {
    if (method === 'GET') {
      const perPage = Math.max(1, Number(searchParams.get('per_page')) || 30);
      const page = Math.max(1, Number(searchParams.get('page')) || 1);
      const all = [...state.gists.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      const items = all.slice((page - 1) * perPage, page * perPage).map((g) => summaryOf(g, login));
      return reply(200, items);
    }
    if (method === 'POST') {
      const id = `fakegist${++state.seq}`;
      const now = state.nextTime();
      const gist = {
        id,
        description: json?.description ?? '',
        public: Boolean(json?.public),
        created_at: now,
        updated_at: now,
        files: {},
      };
      applyFiles(gist, json?.files);
      state.gists.set(id, gist);
      return reply(201, fullOf(gist, login));
    }
  }

  const m = path.match(/^\/gists\/([^/]+)$/);
  if (m) {
    const gist = state.gists.get(m[1]);
    if (!gist) return reply(404, { message: 'Not Found' });
    if (method === 'GET') return reply(200, fullOf(gist, login));
    if (method === 'PATCH') {
      if (json && typeof json.description === 'string') gist.description = json.description;
      applyFiles(gist, json?.files);
      gist.updated_at = state.nextTime();
      return reply(200, fullOf(gist, login));
    }
  }

  return reply(404, { message: `Not Found (${method} ${path})` });
}

function headerOf(headers, name) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function reply(status, body, extraHeaders = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/** Applies a gist `files` patch: `{ name: { content } }` sets a file, `{ name: null }` deletes it. */
function applyFiles(gist, files) {
  for (const [name, spec] of Object.entries(files || {})) {
    if (spec == null) delete gist.files[name];
    else gist.files[name] = { filename: spec.filename || name, content: String(spec.content ?? '') };
  }
}

function fileMeta(gist, name, file, login) {
  return {
    filename: file.filename,
    type: 'application/json',
    language: 'JSON',
    raw_url: `https://gist.githubusercontent.com/${login}/${gist.id}/raw/${encodeURIComponent(name)}`,
    size: Buffer.byteLength(file.content, 'utf8'),
    truncated: false,
  };
}

/** List representation: like GitHub, no `content` in the files map. */
function summaryOf(gist, login) {
  return {
    id: gist.id,
    description: gist.description,
    public: gist.public,
    created_at: gist.created_at,
    updated_at: gist.updated_at,
    files: Object.fromEntries(Object.entries(gist.files).map(([n, f]) => [n, fileMeta(gist, n, f, login)])),
  };
}

/** Single-gist representation: files include `content`. */
function fullOf(gist, login) {
  return {
    ...summaryOf(gist, login),
    files: Object.fromEntries(
      Object.entries(gist.files).map(([n, f]) => [n, { ...fileMeta(gist, n, f, login), content: f.content }]),
    ),
  };
}

/**
 * @param {{ login?: string }} [options]
 * @returns {{ state: { gists: Map<string, object>, seq: number, nextTime: () => string }, handler: (route: import('@playwright/test').Route) => Promise<void> }}
 */
export function createFakeGithub({ login = 'tester' } = {}) {
  let tick = 0;
  const state = {
    gists: new Map(),
    seq: 0,
    // Strictly increasing timestamps so `updated_at` ordering is deterministic even within one ms.
    nextTime: () => new Date(Date.UTC(2026, 0, 1) + ++tick * 1000).toISOString(),
  };

  async function handler(route) {
    const req = route.request();
    let json = null;
    try { json = req.postDataJSON(); } catch { /* no body or not JSON */ }
    const res = respond(state, login, { method: req.method().toUpperCase(), url: req.url(), headers: req.headers(), json });
    await route.fulfill(res);
  }

  return { state, handler };
}

/** Routes every api.github.com request of a BrowserContext (or Page) through the fake. */
export function install(context, fake) {
  return context.route(`${API_ORIGIN}/**`, fake.handler);
}
