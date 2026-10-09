// GitHub Gist sync (SPEC §7): a small REST client, the pure deterministic merge of two workspaces
// (§7.1) and the runSync flow that ties them together (§7.2). No DOM, no storage, no clock other
// than the optional `now` used to compute rate-limit backoff.
import { stableJson } from './model.js';
import { serializeExport, parseImport } from './storage.js';

export const GIST_FILENAME = 'standup-set-builder.json';
export const GIST_DESCRIPTION = 'Stand-Up Set Builder data';
export const GIST_SCOPE_MESSAGE = "This token can't access gists. Create a classic token with the gist scope.";
export const UNREADABLE_REMOTE_MESSAGE = 'Remote data is unreadable';

const API_VERSION = '2022-11-28';
const MIN_RETRY_AFTER_MS = 60_000;
const FIND_PAGE_SIZE = 100;
const FIND_MAX_PAGES = 5;

/** Error raised by the client and by runSync; `kind` drives the sync manager's status handling. */
export class SyncError extends Error {
  /**
   * @param {string} message human-readable, shown in Settings › Sync
   * @param {{ kind?: 'auth'|'network'|'notfound'|'ratelimit'|'other', status?: number|null, retryAfterMs?: number, cause?: unknown }} [details]
   */
  constructor(message, { kind = 'other', status = null, retryAfterMs, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SyncError';
    this.kind = kind;
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Client

/** Milliseconds to wait before the next request, from `retry-after` (seconds) or `x-ratelimit-reset` (epoch seconds). */
function retryAfterMsOf(headers, now) {
  const retryAfter = headers.get('retry-after');
  let ms = retryAfter === null ? NaN : Number(retryAfter) * 1000;
  if (!Number.isFinite(ms)) {
    const reset = Number(headers.get('x-ratelimit-reset'));
    ms = Number.isFinite(reset) && reset > 0 ? reset * 1000 - now() : NaN;
  }
  return Math.max(MIN_RETRY_AFTER_MS, Number.isFinite(ms) ? ms : 0);
}

/** Map a non-OK response to a SyncError (SPEC §7 error mapping). `path` is the API path requested. */
function errorFromResponse(res, path, now) {
  const { status } = res;
  const onGists = path.startsWith('/gists');
  const rateLimited = res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after') !== null;
  if ((status === 403 || status === 429) && rateLimited) {
    return new SyncError('GitHub rate limit reached — sync will retry later', {
      kind: 'ratelimit',
      status,
      retryAfterMs: retryAfterMsOf(res.headers, now),
    });
  }
  if (status === 401) return new SyncError('GitHub rejected the token', { kind: 'auth', status });
  if (status === 403) return new SyncError(onGists ? GIST_SCOPE_MESSAGE : 'GitHub refused the request', { kind: 'auth', status });
  if (status === 404) return new SyncError(onGists ? GIST_SCOPE_MESSAGE : 'GitHub resource not found', { kind: 'notfound', status });
  return new SyncError(`GitHub returned HTTP ${status}`, { kind: 'other', status });
}

/**
 * GitHub REST client scoped to what sync needs. `fetch` is injectable for tests; `now` only feeds
 * the rate-limit backoff computation.
 */
export function createClient({ token, fetch = globalThis.fetch, baseUrl = 'https://api.github.com', now = Date.now } = {}) {
  const fetchImpl = fetch;

  /** fetch that turns transport failures (rejection, TypeError) into a `network` SyncError. */
  async function send(url, init) {
    try {
      // Called with globalThis as `this`: browsers reject a detached fetch invoked on another receiver.
      return await fetchImpl.call(globalThis, url, init);
    } catch (err) {
      throw new SyncError('Network error — check your connection', { kind: 'network', cause: err });
    }
  }

  /** Authenticated JSON request against the API. Returns { data, headers }. */
  async function request(path, { method = 'GET', body } = {}) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
    };
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await send(baseUrl + path, init);
    if (!res.ok) throw errorFromResponse(res, path, now);
    const text = await res.text();
    let data = null;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch (err) {
        // A 2xx that is not JSON did not come from the API: a captive portal or proxy answered.
        throw new SyncError('Network error — the connection is being intercepted', { kind: 'network', status: res.status, cause: err });
      }
    }
    return { data, headers: res.headers };
  }

  /** The API object a successful create/write must carry; anything else is an unexpected response. */
  function expectObject(data, what) {
    if (data && typeof data === 'object') return data;
    throw new SyncError(`GitHub returned an unexpected response to ${what}`, { kind: 'other' });
  }

  /** The file content of a truncated gist: fetched from raw_url, unauthenticated and uncached. */
  async function fetchRaw(rawUrl) {
    const res = await send(rawUrl, { cache: 'no-store' });
    if (!res.ok) throw errorFromResponse(res, new URL(rawUrl).pathname, now);
    return res.text();
  }

  function fileSpec(content) {
    return { [GIST_FILENAME]: { content } };
  }

  return {
    async whoami() {
      const { data, headers } = await request('/user');
      const scopes = (headers.get('x-oauth-scopes') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return { login: data?.login ?? '', scopes };
    },

    async findGist() {
      for (let page = 1; page <= FIND_MAX_PAGES; page++) {
        const { data } = await request(`/gists?per_page=${FIND_PAGE_SIZE}&page=${page}`);
        const list = Array.isArray(data) ? data : [];
        const hit = list.find((g) => g && g.files && Object.hasOwn(g.files, GIST_FILENAME));
        if (hit) return { id: hit.id, updated_at: hit.updated_at };
        if (list.length < FIND_PAGE_SIZE) return null;
      }
      return null;
    },

    async createGist(contentString) {
      const { data } = await request('/gists', {
        method: 'POST',
        body: { description: GIST_DESCRIPTION, public: false, files: fileSpec(contentString) },
      });
      const gist = expectObject(data, 'creating the gist');
      return { id: gist.id, updated_at: gist.updated_at };
    },

    async readGist(id) {
      const { data } = await request(`/gists/${encodeURIComponent(id)}`);
      const file = data?.files?.[GIST_FILENAME];
      if (!file) {
        // The gist exists but no longer carries our file: treat it like a missing gist so runSync
        // recovers by finding/creating a usable one instead of failing forever.
        throw new SyncError(`The gist has no ${GIST_FILENAME} file`, { kind: 'notfound', status: 404 });
      }
      const content = file.truncated ? await fetchRaw(file.raw_url) : file.content;
      return { content: String(content ?? ''), updated_at: data.updated_at };
    },

    async writeGist(id, contentString) {
      const { data } = await request(`/gists/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { files: fileSpec(contentString) },
      });
      return { updated_at: expectObject(data, 'writing the gist').updated_at };
    },
  };
}

// ---------------------------------------------------------------------------
// Merge (SPEC §7.1) — pure: no clock, no random ids, inputs untouched, symmetric version set.

/** The part of a version that counts as "content" for conflict detection. */
function contentKey(version) {
  return stableJson({ topics: version.topics, jokeIds: version.set.jokeIds });
}

/** Rule 2 for one id present on both sides: [winner, loser]. Symmetric in its arguments. */
function pickWinner(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? [a, b] : [b, a];
  const aj = stableJson(a);
  const bj = stableJson(b);
  return aj <= bj ? [a, b] : [b, a];
}

/**
 * Rule 3c: a deep copy of `v` under a deterministic id, with every entity id remapped. The remap
 * carries the version's `updatedAt` (like the copy's own id) so that two conflict copies of the
 * same version made at different times never share topic/joke/alt ids: ids must stay unique
 * across the workspace, and normalize would otherwise re-id the later copy and empty its set.
 */
function conflictCopy(v) {
  const copyId = (id) => (id == null ? null : `${id}~c~${v.updatedAt}`);
  return {
    id: `${v.id}~conflict~${v.updatedAt}`,
    name: `${v.name} (conflict copy)`,
    createdAt: v.updatedAt,
    updatedAt: v.updatedAt,
    topics: v.topics.map((topic) => ({
      id: copyId(topic.id),
      title: topic.title,
      color: topic.color,
      jokes: topic.jokes.map((joke) => ({
        id: copyId(joke.id),
        title: joke.title,
        text: joke.text,
        alts: joke.alts.map((alt) => ({ id: copyId(alt.id), text: alt.text })),
        activeAltId: copyId(joke.activeAltId),
        overrideSec: joke.overrideSec,
        notes: joke.notes,
      })),
    })),
    set: { jokeIds: v.set.jokeIds.map(copyId), updatedAt: v.set.updatedAt },
  };
}

function compareVersions(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function laterIso(a, b) {
  return a > b ? a : b;
}

/**
 * Merge two workspaces. `synced` is this device's record of each version's `updatedAt` when it was
 * last reconciled with the gist; a version whose `updatedAt` differs from it (or is unknown) has
 * changed since.
 */
export function merge(localIn, remoteIn, { synced = {} } = {}) {
  const local = structuredClone(localIn);
  const remote = structuredClone(remoteIn);
  const changed = (v) => synced[v.id] !== v.updatedAt;

  // 1. Tombstones: union, later time per id.
  const tombstones = { ...(local.tombstones || {}) };
  for (const [id, at] of Object.entries(remote.tombstones || {})) {
    if (!(id in tombstones) || at > tombstones[id]) tombstones[id] = at;
  }
  const deletedBy = (v) => tombstones[v.id] !== undefined && tombstones[v.id] > v.updatedAt;

  // 2 + 3. Union by id with LWW; conflict copies for diverged edits and for unsynced edits that a
  // tombstone would otherwise delete.
  const localById = new Map(local.versions.map((v) => [v.id, v]));
  const remoteById = new Map(remote.versions.map((v) => [v.id, v]));
  const ids = [...new Set([...localById.keys(), ...remoteById.keys()])];
  const kept = new Map(); // id → version in the merged workspace
  const dropped = []; // winners removed by a tombstone (fallback when nothing survives)
  const copies = new Map(); // copy id → copy (candidates; filtered below)
  const proposeCopy = (v) => {
    const copy = conflictCopy(v);
    if (!localById.has(copy.id) && !remoteById.has(copy.id) && !copies.has(copy.id)) copies.set(copy.id, copy);
  };

  for (const id of ids) {
    const l = localById.get(id);
    const r = remoteById.get(id);
    let winner = l ?? r;
    if (l && r) {
      const [w, loser] = pickWinner(l, r);
      winner = w;
      // 3a: both sides edited since the common base and the content differs → keep the loser too.
      if (changed(l) && changed(r) && contentKey(l) !== contentKey(r)) proposeCopy(loser);
    }
    if (deletedBy(winner)) {
      // 3b: edits that never reached the deleting device survive as a copy.
      if (changed(winner)) proposeCopy(winner);
      dropped.push(winner);
      continue;
    }
    kept.set(id, winner);
  }

  const conflictCopies = [];
  for (const copy of copies.values()) {
    if (deletedBy(copy)) continue; // the user already deleted this very copy on some device
    kept.set(copy.id, copy);
    conflictCopies.push(copy.name);
  }

  // A workspace always has ≥1 version. If cross-deletions emptied it, resurrect the most recently
  // edited casualty (deterministically) and forget its tombstone so both sides converge on it.
  if (kept.size === 0 && dropped.length > 0) {
    const revived = dropped.reduce((best, v) => (v.updatedAt > best.updatedAt || (v.updatedAt === best.updatedAt && v.id > best.id) ? v : best));
    delete tombstones[revived.id];
    kept.set(revived.id, revived);
  }

  // 4. Settings: later settingsUpdatedAt wins, tie → local.
  const remoteSettingsWin = remote.settingsUpdatedAt > local.settingsUpdatedAt;
  const settingsSource = remoteSettingsWin ? remote : local;

  // 5 + 6. Active version, ordering, timestamps, identity.
  const versions = [...kept.values()].sort(compareVersions);
  let activeVersionId;
  if (kept.has(local.activeVersionId)) activeVersionId = local.activeVersionId;
  else if (kept.has(remote.activeVersionId)) activeVersionId = remote.activeVersionId;
  else activeVersionId = versions[0]?.id;

  const workspace = {
    schemaVersion: local.schemaVersion,
    id: local.id,
    settings: settingsSource.settings,
    settingsUpdatedAt: settingsSource.settingsUpdatedAt,
    activeVersionId,
    versions,
    tombstones,
    updatedAt: laterIso(local.updatedAt, remote.updatedAt),
  };

  // 7. Change flags relative to the untouched inputs.
  const mergedJson = stableJson(workspace);
  return {
    workspace,
    localChanged: mergedJson !== stableJson(localIn),
    remoteChanged: mergedJson !== stableJson(remoteIn),
    conflictCopies,
  };
}

// ---------------------------------------------------------------------------
// runSync (SPEC §7.2)

/** `{ versionId: updatedAt }` snapshot recorded after a successful reconciliation. */
export function syncedMapOf(ws) {
  return Object.fromEntries((ws.versions || []).map((v) => [v.id, v.updatedAt]));
}

/** A workspace nobody has written in: one version, no topics, empty set. */
function isPristine(ws) {
  if (ws.versions.length !== 1) return false;
  const [v] = ws.versions;
  return v.topics.length === 0 && v.set.jokeIds.length === 0;
}

/** Parse the gist's content; anything unreadable becomes a SyncError so the remote is never overwritten. */
function parseRemote(content) {
  try {
    return parseImport(content);
  } catch (err) {
    throw new SyncError(UNREADABLE_REMOTE_MESSAGE, { kind: 'other', cause: err });
  }
}

/**
 * One full reconciliation against the gist. Resolves with the workspace to adopt locally (when
 * `localChanged`), the gist id to remember and the `synced` map to store — the latter only once
 * the remote write (if any) has succeeded.
 */
export async function runSync({ client, workspace, gistId = null, synced = {} }) {
  let id = gistId;
  // A stale gist id (gist deleted on GitHub) is forgiven once: find or create a gist and retry.
  for (let attempt = 0; ; attempt++) {
    if (id == null) {
      const found = await client.findGist();
      if (!found) {
        const created = await client.createGist(serializeExport(workspace));
        return {
          workspace,
          gistId: created.id,
          pushed: true,
          pulled: false,
          localChanged: false,
          remoteChanged: true,
          conflictCopies: [],
          remoteUpdatedAt: created.updated_at,
          synced: syncedMapOf(workspace),
        };
      }
      id = found.id;
    }
    try {
      return await syncWithGist({ client, workspace, gistId: id, synced });
    } catch (err) {
      if (err instanceof SyncError && err.kind === 'notfound' && attempt === 0) {
        id = null;
        continue;
      }
      throw err;
    }
  }
}

/** Steps 2–6 of §7.2 against a known gist id. */
async function syncWithGist({ client, workspace, gistId, synced }) {
  const read = await client.readGist(gistId);
  const remote = parseRemote(read.content);

  let result;
  if (isPristine(workspace) && Object.keys(synced).length === 0) {
    // Pristine adoption: a fresh device takes the remote as-is instead of merging an empty version in.
    result = { workspace: remote, localChanged: true, remoteChanged: false, conflictCopies: [] };
  } else {
    result = merge(workspace, remote, { synced });
  }

  let remoteUpdatedAt = read.updated_at;
  if (result.remoteChanged) {
    const written = await client.writeGist(gistId, serializeExport(result.workspace));
    remoteUpdatedAt = written.updated_at;
  }
  return {
    workspace: result.workspace,
    gistId,
    pushed: result.remoteChanged,
    pulled: result.localChanged,
    localChanged: result.localChanged,
    remoteChanged: result.remoteChanged,
    conflictCopies: result.conflictCopies,
    remoteUpdatedAt,
    synced: syncedMapOf(result.workspace),
  };
}
