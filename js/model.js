// Pure workspace data model (SPEC §3): creation, lookup, mutations, normalize and stableJson.
// No DOM, no storage, no clock other than ids.js. Mutations change the passed workspace in place;
// the store wraps them with cloning, undo and persistence.
import { newId, nowIso } from './ids.js';

export const SCHEMA_VERSION = 1;
export const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

const DEFAULT_SETTINGS = Object.freeze({ wpm: 140, pauseSec: 2, targetSec: 300, theme: 'system', colWidth: 360 });
const THEMES = ['system', 'light', 'dark'];
const COL_WIDTHS = [320, 360, 420];
const SETTINGS_RANGES = { wpm: [60, 300], pauseSec: [0, 30], targetSec: [1, 36000] };

// ---------------------------------------------------------------------------
// Generic helpers

/** JSON.stringify with object keys sorted recursively, so equal content gives equal text. */
export function stableJson(value) {
  return JSON.stringify(value, (key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Insert `item` into `list` at `index` (clamped to [0, length]); `undefined`/non-finite ⇒ append. */
function insertAt(list, item, index) {
  const at = Number.isFinite(index) ? clamp(Math.trunc(index), 0, list.length) : list.length;
  list.splice(at, 0, item);
  return at;
}

/** Remove the first element matching `pred`; returns it or undefined. */
function pullWhere(list, pred) {
  const i = list.findIndex(pred);
  return i === -1 ? undefined : list.splice(i, 1)[0];
}

/** Order versions by (createdAt, id); both compared as strings. */
function compareVersions(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function sortVersions(ws) {
  ws.versions.sort(compareVersions);
}

/** Stamp a version (and the workspace) as changed; `setChanged` also stamps the set. */
function touchVersion(ws, version, { setChanged = false } = {}) {
  const now = nowIso();
  version.updatedAt = now;
  if (setChanged) version.set.updatedAt = now;
  ws.updatedAt = now;
}

/** Remove every id in `ids` from the active version's set; returns true when something was removed. */
function dropFromSet(version, ids) {
  const drop = new Set(ids);
  const before = version.set.jokeIds.length;
  version.set.jokeIds = version.set.jokeIds.filter((id) => !drop.has(id));
  return version.set.jokeIds.length !== before;
}

// ---------------------------------------------------------------------------
// Creation

/** A brand-new workspace with default settings and one empty version. */
export function createWorkspace({ name = 'Set v1' } = {}) {
  const id = newId();
  const version = createVersion({ name });
  const now = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    settings: { ...DEFAULT_SETTINGS },
    settingsUpdatedAt: now,
    activeVersionId: version.id,
    versions: [version],
    tombstones: {},
    updatedAt: now,
  };
}

/**
 * A new version. With `from`, a deep copy of that version in which every topic/joke/alt gets a
 * fresh id, and set.jokeIds / activeAltId are remapped accordingly.
 */
export function createVersion({ name, from = null } = {}) {
  const now = nowIso();
  const version = {
    id: newId(),
    name: String(name ?? 'Untitled'),
    createdAt: now,
    updatedAt: now,
    topics: [],
    set: { jokeIds: [], updatedAt: now },
  };
  if (from) {
    const jokeIdMap = new Map();
    version.topics = (from.topics || []).map((topic) => ({
      id: newId(),
      title: topic.title,
      color: topic.color,
      jokes: (topic.jokes || []).map((joke) => {
        const copy = copyJoke(joke);
        jokeIdMap.set(joke.id, copy.id);
        return copy;
      }),
    }));
    version.set.jokeIds = (from.set?.jokeIds || []).filter((id) => jokeIdMap.has(id)).map((id) => jokeIdMap.get(id));
  }
  return version;
}

/** Deep copy of a joke with fresh ids for the joke and its alts (activeAltId remapped). */
function copyJoke(joke) {
  const altIdMap = new Map();
  const alts = joke.alts.map((alt) => {
    const id = newId();
    altIdMap.set(alt.id, id);
    return { id, text: alt.text };
  });
  return {
    id: newId(),
    title: joke.title,
    text: joke.text,
    alts,
    activeAltId: altIdMap.get(joke.activeAltId) ?? null,
    overrideSec: joke.overrideSec,
    notes: joke.notes,
  };
}

// ---------------------------------------------------------------------------
// normalize (SPEC §3.2) — defensive: never throws for an object input, idempotent, never drops a version.

function normalizeIso(value) {
  if (typeof value !== 'string' || value === '') return EPOCH_ISO;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return EPOCH_ISO;
  // Canonical form so timestamps compare correctly as strings (a no-op for values from nowIso()).
  return new Date(ms).toISOString();
}

function normalizeSettings(raw) {
  const src = isObject(raw) ? raw : {};
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(SETTINGS_RANGES)) {
    const n = Number(src[key]);
    if (src[key] !== null && src[key] !== '' && Number.isFinite(n)) out[key] = clamp(n, ...SETTINGS_RANGES[key]);
  }
  if (THEMES.includes(src.theme)) out.theme = src.theme;
  if (COL_WIDTHS.includes(Number(src.colWidth))) out.colWidth = Number(src.colWidth);
  return out;
}

function normalizeTombstones(raw) {
  const out = {};
  if (!isObject(raw)) return out;
  for (const [id, at] of Object.entries(raw)) if (typeof at === 'string') out[id] = at;
  return out;
}

/** Returns `id` if it is a usable, unseen string; otherwise a fresh id. Records the result in `seen`. */
function uniqueId(id, seen) {
  let out = typeof id === 'string' && id !== '' && !seen.has(id) ? id : newId();
  while (seen.has(out)) out = newId();
  seen.add(out);
  return out;
}

function normalizeAlt(raw, seen) {
  return { id: uniqueId(raw.id, seen), text: String(raw.text ?? '') };
}

function normalizeJoke(raw, seen) {
  const alts = (Array.isArray(raw.alts) ? raw.alts : []).filter(isObject).map((a) => normalizeAlt(a, seen));
  const overrideSec = Number.isFinite(raw.overrideSec) && raw.overrideSec >= 0 ? raw.overrideSec : null;
  const activeAltId = alts.some((a) => a.id === raw.activeAltId) ? raw.activeAltId : null;
  return {
    id: uniqueId(raw.id, seen),
    title: String(raw.title ?? ''),
    text: String(raw.text ?? ''),
    alts,
    activeAltId,
    overrideSec,
    notes: String(raw.notes ?? ''),
  };
}

function normalizeTopic(raw, seen) {
  return {
    id: uniqueId(raw.id, seen),
    title: String(raw.title ?? ''),
    color: typeof raw.color === 'string' ? raw.color : null,
    jokes: (Array.isArray(raw.jokes) ? raw.jokes : []).filter(isObject).map((j) => normalizeJoke(j, seen)),
    // `collapsed` is per-device UI state (§9.3) and must never live in the workspace.
  };
}

function normalizeVersion(raw, seen) {
  const topics = (Array.isArray(raw.topics) ? raw.topics : []).filter(isObject).map((t) => normalizeTopic(t, seen));
  const jokeIds = new Set(topics.flatMap((t) => t.jokes.map((j) => j.id)));
  const rawSet = isObject(raw.set) ? raw.set : {};
  const setIds = [];
  for (const id of Array.isArray(rawSet.jokeIds) ? rawSet.jokeIds : []) {
    if (jokeIds.has(id) && !setIds.includes(id)) setIds.push(id);
  }
  return {
    id: raw.id,
    name: String(raw.name ?? 'Untitled'),
    createdAt: normalizeIso(raw.createdAt),
    updatedAt: normalizeIso(raw.updatedAt),
    topics,
    set: { jokeIds: setIds, updatedAt: normalizeIso(rawSet.updatedAt) },
  };
}

/** Repair a workspace of unknown provenance in place and return it. Throws only for non-object input. */
export function normalize(ws) {
  if (!isObject(ws)) throw new Error('Workspace must be an object');
  ws.schemaVersion = SCHEMA_VERSION;
  if (typeof ws.id !== 'string' || ws.id === '') ws.id = newId();
  ws.settings = normalizeSettings(ws.settings);
  ws.settingsUpdatedAt = normalizeIso(ws.settingsUpdatedAt);
  ws.updatedAt = normalizeIso(ws.updatedAt);
  ws.tombstones = normalizeTombstones(ws.tombstones);

  // Versions: objects only, each with a usable id; duplicate ids keep the later updatedAt.
  const rawVersions = (Array.isArray(ws.versions) ? ws.versions : []).filter(isObject);
  const versionIds = new Set();
  for (const v of rawVersions) {
    if (typeof v.id !== 'string' || v.id === '') v.id = newId();
    v.updatedAt = normalizeIso(v.updatedAt);
  }
  const byId = new Map();
  for (const v of rawVersions) {
    const prev = byId.get(v.id);
    if (!prev || v.updatedAt > prev.updatedAt) byId.set(v.id, v);
  }
  for (const id of byId.keys()) versionIds.add(id);

  // Entity ids are unique across the whole workspace: a second occurrence gets a fresh id.
  const seen = new Set([ws.id, ...versionIds]);
  ws.versions = [...byId.values()].map((v) => normalizeVersion(v, seen));
  sortVersions(ws);
  if (ws.versions.length === 0) ws.versions.push(createVersion({ name: 'Set v1' }));
  if (!ws.versions.some((v) => v.id === ws.activeVersionId)) ws.activeVersionId = ws.versions[0].id;
  return ws;
}

// ---------------------------------------------------------------------------
// Lookup (active version only)

export function activeVersion(ws) {
  const version = ws.versions.find((v) => v.id === ws.activeVersionId);
  if (!version) throw new Error(`Unknown version: ${ws.activeVersionId}`);
  return version;
}

function versionById(ws, versionId) {
  const version = ws.versions.find((v) => v.id === versionId);
  if (!version) throw new Error(`Unknown version: ${versionId}`);
  return version;
}

export function findTopic(ws, topicId) {
  const version = activeVersion(ws);
  const index = version.topics.findIndex((t) => t.id === topicId);
  return index === -1 ? null : { version, topic: version.topics[index], index };
}

export function findJoke(ws, jokeId) {
  const version = activeVersion(ws);
  for (let topicIndex = 0; topicIndex < version.topics.length; topicIndex++) {
    const topic = version.topics[topicIndex];
    const index = topic.jokes.findIndex((j) => j.id === jokeId);
    if (index !== -1) return { version, topic, topicIndex, joke: topic.jokes[index], index };
  }
  return null;
}

export function findAlt(ws, altId) {
  const version = activeVersion(ws);
  for (const topic of version.topics) {
    for (const joke of topic.jokes) {
      const index = joke.alts.findIndex((a) => a.id === altId);
      if (index !== -1) return { version, topic, joke, alt: joke.alts[index], index };
    }
  }
  return null;
}

function requireTopic(ws, topicId) {
  const hit = findTopic(ws, topicId);
  if (!hit) throw new Error(`Unknown topic: ${topicId}`);
  return hit;
}

function requireJoke(ws, jokeId) {
  const hit = findJoke(ws, jokeId);
  if (!hit) throw new Error(`Unknown joke: ${jokeId}`);
  return hit;
}

function requireAlt(ws, altId) {
  const hit = findAlt(ws, altId);
  if (!hit) throw new Error(`Unknown alt: ${altId}`);
  return hit;
}

/** The text delivered on stage: the active alt's text, or the joke's own text. */
export function deliveredText(joke) {
  if (joke.activeAltId != null) {
    const alt = joke.alts.find((a) => a.id === joke.activeAltId);
    if (alt) return alt.text;
  }
  return joke.text;
}

// ---------------------------------------------------------------------------
// Topics

export function addTopic(ws, { title = '', color = null } = {}, index = undefined) {
  const version = activeVersion(ws);
  const topic = { id: newId(), title: String(title), color: color == null ? null : String(color), jokes: [] };
  insertAt(version.topics, topic, index);
  touchVersion(ws, version);
  return topic.id;
}

export function updateTopic(ws, topicId, patch) {
  const { version, topic } = requireTopic(ws, topicId);
  if ('title' in patch) topic.title = String(patch.title ?? '');
  if ('color' in patch) topic.color = patch.color == null ? null : String(patch.color);
  touchVersion(ws, version);
}

export function removeTopic(ws, topicId) {
  const { version, topic, index } = requireTopic(ws, topicId);
  version.topics.splice(index, 1);
  const setChanged = dropFromSet(version, topic.jokes.map((j) => j.id));
  touchVersion(ws, version, { setChanged });
}

export function moveTopic(ws, topicId, toIndex) {
  const { version, topic, index } = requireTopic(ws, topicId);
  version.topics.splice(index, 1);
  insertAt(version.topics, topic, toIndex);
  touchVersion(ws, version);
}

// ---------------------------------------------------------------------------
// Jokes

export function addJoke(ws, topicId, { title = '', text = '' } = {}, index = undefined) {
  const { version, topic } = requireTopic(ws, topicId);
  const joke = {
    id: newId(),
    title: String(title),
    text: String(text),
    alts: [],
    activeAltId: null,
    overrideSec: null,
    notes: '',
  };
  insertAt(topic.jokes, joke, index);
  touchVersion(ws, version);
  return joke.id;
}

export function updateJoke(ws, jokeId, patch) {
  const { version, joke } = requireJoke(ws, jokeId);
  if ('overrideSec' in patch && patch.overrideSec !== null) {
    if (!Number.isFinite(patch.overrideSec) || patch.overrideSec < 0) {
      throw new Error('overrideSec must be null or a finite number ≥ 0');
    }
  }
  if ('activeAltId' in patch && patch.activeAltId !== null && !joke.alts.some((a) => a.id === patch.activeAltId)) {
    throw new Error(`Alt ${patch.activeAltId} does not belong to joke ${jokeId}`);
  }
  if ('title' in patch) joke.title = String(patch.title ?? '');
  if ('text' in patch) joke.text = String(patch.text ?? '');
  if ('notes' in patch) joke.notes = String(patch.notes ?? '');
  if ('overrideSec' in patch) joke.overrideSec = patch.overrideSec;
  if ('activeAltId' in patch) joke.activeAltId = patch.activeAltId;
  touchVersion(ws, version);
}

export function removeJoke(ws, jokeId) {
  const { version, topic, index } = requireJoke(ws, jokeId);
  topic.jokes.splice(index, 1);
  const setChanged = dropFromSet(version, [jokeId]);
  touchVersion(ws, version, { setChanged });
}

/** Copy a joke (fresh ids for it and its alts) right after the source. The copy is not in the set. */
export function duplicateJoke(ws, jokeId) {
  const { version, topic, joke, index } = requireJoke(ws, jokeId);
  const copy = copyJoke(joke);
  topic.jokes.splice(index + 1, 0, copy);
  touchVersion(ws, version);
  return copy.id;
}

export function moveJoke(ws, jokeId, toTopicId, toIndex) {
  const { version, topic, joke, index } = requireJoke(ws, jokeId);
  const { topic: target } = requireTopic(ws, toTopicId);
  topic.jokes.splice(index, 1);
  insertAt(target.jokes, joke, toIndex);
  touchVersion(ws, version);
}

// ---------------------------------------------------------------------------
// Alts

export function addAlt(ws, jokeId, { text = '' } = {}, index = undefined) {
  const { version, joke } = requireJoke(ws, jokeId);
  const alt = { id: newId(), text: String(text) };
  insertAt(joke.alts, alt, index);
  touchVersion(ws, version);
  return alt.id;
}

export function updateAlt(ws, altId, patch) {
  const { version, alt } = requireAlt(ws, altId);
  if ('text' in patch) alt.text = String(patch.text ?? '');
  touchVersion(ws, version);
}

export function removeAlt(ws, altId) {
  const { version, joke, index } = requireAlt(ws, altId);
  joke.alts.splice(index, 1);
  if (joke.activeAltId === altId) joke.activeAltId = null;
  touchVersion(ws, version);
}

export function moveAlt(ws, altId, toJokeId, toIndex) {
  const { version, joke, alt, index } = requireAlt(ws, altId);
  const { joke: target } = requireJoke(ws, toJokeId);
  joke.alts.splice(index, 1);
  if (target !== joke && joke.activeAltId === altId) joke.activeAltId = null;
  insertAt(target.alts, alt, toIndex);
  touchVersion(ws, version);
}

export function setActiveAlt(ws, jokeId, altId) {
  const { version, joke } = requireJoke(ws, jokeId);
  if (altId !== null && !joke.alts.some((a) => a.id === altId)) {
    throw new Error(`Alt ${altId} does not belong to joke ${jokeId}`);
  }
  joke.activeAltId = altId;
  touchVersion(ws, version);
}

/** Make the alt the main joke: swap its text with the joke's text; the joke's own text is delivered. */
export function promoteAlt(ws, altId) {
  const { version, joke, alt } = requireAlt(ws, altId);
  [joke.text, alt.text] = [alt.text, joke.text];
  joke.activeAltId = null;
  touchVersion(ws, version);
}

// ---------------------------------------------------------------------------
// Set

export function isInSet(ws, jokeId) {
  return activeVersion(ws).set.jokeIds.includes(jokeId);
}

export function addToSet(ws, jokeId, index = undefined) {
  const { version } = requireJoke(ws, jokeId);
  if (version.set.jokeIds.includes(jokeId)) return;
  insertAt(version.set.jokeIds, jokeId, index);
  touchVersion(ws, version, { setChanged: true });
}

export function removeFromSet(ws, jokeId) {
  const { version } = requireJoke(ws, jokeId);
  if (!dropFromSet(version, [jokeId])) return;
  touchVersion(ws, version, { setChanged: true });
}

export function toggleInSet(ws, jokeId) {
  if (isInSet(ws, jokeId)) {
    removeFromSet(ws, jokeId);
    return false;
  }
  addToSet(ws, jokeId);
  return true;
}

export function moveInSet(ws, jokeId, toIndex) {
  const { version } = requireJoke(ws, jokeId);
  const removed = pullWhere(version.set.jokeIds, (id) => id === jokeId);
  if (removed === undefined) throw new Error('Joke not in set');
  insertAt(version.set.jokeIds, jokeId, toIndex);
  touchVersion(ws, version, { setChanged: true });
}

// ---------------------------------------------------------------------------
// Versions

export function addVersion(ws, { name, fromVersionId = ws.activeVersionId } = {}) {
  const from = fromVersionId == null ? null : versionById(ws, fromVersionId);
  const versionName = name ?? (from ? `${from.name} copy` : `Set v${ws.versions.length + 1}`);
  const version = createVersion({ name: versionName, from });
  ws.versions.push(version);
  sortVersions(ws);
  ws.activeVersionId = version.id;
  ws.updatedAt = nowIso();
  return version.id;
}

export function renameVersion(ws, versionId, name) {
  const version = versionById(ws, versionId);
  version.name = String(name ?? '');
  touchVersion(ws, version);
}

export function deleteVersion(ws, versionId) {
  versionById(ws, versionId);
  if (ws.versions.length <= 1) throw new Error('Cannot delete the only version');
  const now = nowIso();
  ws.versions = ws.versions.filter((v) => v.id !== versionId);
  ws.tombstones[versionId] = now;
  if (ws.activeVersionId === versionId) {
    // Versions are sorted by (createdAt, id); the last one has the greatest createdAt.
    ws.activeVersionId = ws.versions[ws.versions.length - 1].id;
  }
  ws.updatedAt = now;
}

export function switchVersion(ws, versionId) {
  versionById(ws, versionId);
  ws.activeVersionId = versionId;
  ws.updatedAt = nowIso();
}

// ---------------------------------------------------------------------------
// Settings

/** Validates types (throws) but does not clamp ranges: normalize clamps on load, so partial typing works. */
export function updateSettings(ws, patch) {
  if (!isObject(patch)) throw new Error('Settings patch must be an object');
  const next = { ...ws.settings };
  for (const key of Object.keys(SETTINGS_RANGES)) {
    if (!(key in patch)) continue;
    if (typeof patch[key] !== 'number' || !Number.isFinite(patch[key])) throw new Error(`${key} must be a finite number`);
    next[key] = patch[key];
  }
  if ('theme' in patch) {
    if (!THEMES.includes(patch.theme)) throw new Error(`Unknown theme: ${patch.theme}`);
    next.theme = patch.theme;
  }
  if ('colWidth' in patch) {
    if (!COL_WIDTHS.includes(patch.colWidth)) throw new Error(`Unsupported column width: ${patch.colWidth}`);
    next.colWidth = patch.colWidth;
  }
  ws.settings = next;
  const now = nowIso();
  ws.settingsUpdatedAt = now;
  ws.updatedAt = now;
}
