// State container (SPEC §8): wraps the pure model mutations with immutable snapshots, undo/redo,
// debounced persistence and change notifications. No DOM; timers use the global setTimeout so
// node:test mock timers work.
//
// Every snapshot handed out by `get()` is immutable by contract: `apply` runs the mutator on a
// structuredClone of the current snapshot and only adopts the clone when its stable JSON differs,
// so a mutation that changes nothing (e.g. addToSet on a joke already in the set) pushes no
// history entry, persists nothing and notifies nobody.
import { nowIso } from './ids.js';
import * as model from './model.js';
import { createHistory } from './undo.js';

const { stableJson } = model;

/** Names of the model mutations that `store.actions` binds (SPEC §3.1), in spec order. */
const MUTATION_NAMES = [
  'addTopic', 'updateTopic', 'removeTopic', 'moveTopic',
  'addJoke', 'updateJoke', 'removeJoke', 'duplicateJoke', 'moveJoke',
  'addAlt', 'updateAlt', 'removeAlt', 'moveAlt', 'setActiveAlt', 'promoteAlt',
  'addToSet', 'removeFromSet', 'toggleInSet', 'moveInSet',
  'addVersion', 'renameVersion', 'deleteVersion', 'switchVersion',
  'updateSettings',
];

/**
 * Coalescing key for a bound action call (SPEC §8): consecutive keystrokes into the same text
 * field merge into one undo entry. Mutations that are not text edits return null.
 */
export function coalesceKeyFor(name, args) {
  const patch = args[1];
  const hasKey = (key) => patch != null && typeof patch === 'object' && key in patch;
  switch (name) {
    case 'updateJoke':
      if (hasKey('text')) return `joke:text:${args[0]}`;
      if (hasKey('title')) return `joke:title:${args[0]}`;
      if (hasKey('notes')) return `joke:notes:${args[0]}`;
      return null;
    case 'updateTopic':
      return hasKey('title') ? `topic:title:${args[0]}` : null;
    case 'updateAlt':
      return hasKey('text') ? `alt:text:${args[0]}` : null;
    case 'renameVersion':
      return `version:name:${args[0]}`;
    case 'updateSettings':
      return 'settings';
    default:
      return null;
  }
}

/**
 * Copy of `restored` with the timestamps that a later sync merge relies on bumped to `now`
 * wherever its content differs from `current` (SPEC §8 undo/redo stamping). A plain restore
 * would carry the OLD updatedAt and lose a last-writer-wins merge against the state it undid.
 * The history entry itself is never modified: the copy is what becomes current.
 */
function stampRestored(current, restored, now) {
  const ws = structuredClone(restored);
  const stamp = now();
  const currentVersions = new Map(current.versions.map((v) => [v.id, v]));
  for (const version of ws.versions) {
    const was = currentVersions.get(version.id);
    if (!was || stableJson(was) !== stableJson(version)) {
      version.updatedAt = stamp;
      if (!was || stableJson(was.set.jokeIds) !== stableJson(version.set.jokeIds)) version.set.updatedAt = stamp;
    }
  }
  if (stableJson(current.settings) !== stableJson(ws.settings)) ws.settingsUpdatedAt = stamp;
  // A tombstone the restore (re)introduces is a deletion happening now: with its old time it would
  // lose a merge against the version it deletes, which the undo stamped past that time.
  for (const id of Object.keys(ws.tombstones)) {
    if (current.tombstones[id] !== ws.tombstones[id]) ws.tombstones[id] = stamp;
  }
  ws.updatedAt = stamp;
  return ws;
}

/**
 * @param {object} initialWorkspace   a normalized workspace (the store takes ownership of it)
 * @param {object} [options]
 * @param {(ws: object) => boolean|void} [options.persist]   save hook; a throw or `false` reports a persist error
 * @param {object} [options.history]                          an undo history (js/undo.js)
 * @param {(err: Error) => void} [options.onPersistError]
 * @param {number} [options.debounceMs=150]
 * @param {() => string} [options.now]                        ISO clock used for undo/redo stamping
 */
export function createStore(initialWorkspace, {
  persist = () => true,
  history = createHistory(),
  onPersistError = console.error,
  debounceMs = 150,
  now = nowIso,
} = {}) {
  let current = initialWorkspace;
  const listeners = new Set();
  let persistTimer = null;

  function notify(meta) {
    for (const fn of [...listeners]) fn(current, meta);
  }

  /** Runs the persist hook on the current snapshot, routing failures to onPersistError. */
  function persistNow() {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    try {
      if (persist(current) === false) throw new Error('Persist hook returned false');
    } catch (err) {
      onPersistError(err);
    }
  }

  function schedulePersist() {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, debounceMs);
  }

  function apply(label, mutator, { coalesceKey = null } = {}) {
    const draft = structuredClone(current);
    const result = mutator(draft); // a throw leaves `current` untouched
    if (stableJson(draft) === stableJson(current)) return result;
    history.push(current, { coalesceKey });
    current = draft;
    schedulePersist();
    notify({ source: 'user', label });
    return result;
  }

  /** Shared by undo and redo: `take` pops the snapshot to restore from the history. */
  function restore(take, source) {
    const snapshot = take(current);
    if (snapshot === null) return false;
    current = stampRestored(current, snapshot, now);
    schedulePersist();
    notify({ source, label: source });
    return true;
  }

  function replace(ws, { source = 'replace', resetHistory = true } = {}) {
    model.normalize(ws);
    if (resetHistory) {
      history.clear();
    } else {
      history.push(current);
      history.breakCoalescing(); // the entry is closed: later text edits must not merge into it
    }
    current = ws;
    persistNow();
    notify({ source, label: source });
  }

  function flush() {
    if (persistTimer !== null) persistNow();
  }

  const actions = {};
  for (const name of MUTATION_NAMES) {
    const mutation = model[name];
    if (typeof mutation !== 'function') throw new Error(`model.js does not export mutation ${name}`);
    actions[name] = (...args) => apply(name, (draft) => mutation(draft, ...args), { coalesceKey: coalesceKeyFor(name, args) });
  }

  return {
    get: () => current,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    apply,
    undo: () => restore(history.undo, 'undo'),
    redo: () => restore(history.redo, 'redo'),
    canUndo: () => history.canUndo(),
    canRedo: () => history.canRedo(),
    breakCoalescing: () => history.breakCoalescing(),
    replace,
    flush,
    actions: Object.freeze(actions),
  };
}
