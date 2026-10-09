// Pure undo/redo history stack (SPEC §5). No DOM, no storage, no knowledge of what a "state" is:
// the store hands it immutable workspace snapshots and gets them back unchanged.
//
// `past` holds entries { state, key, closed, at } where `state` is the snapshot taken BEFORE a
// change, `key` is the coalescing key of that change (lives on the entry, never in a side
// variable), `closed` marks that no further change may merge into it, and `at` is the clock time
// of the last change that merged into it. `future` holds plain snapshots to redo.

/**
 * @param {object} [options]
 * @param {number} [options.limit=200]       maximum number of undoable entries
 * @param {number} [options.coalesceMs=1000] idle window within which same-key changes merge
 * @param {() => number} [options.now]       clock in milliseconds (injectable for tests)
 */
export function createHistory({ limit = 200, coalesceMs = 1000, now = Date.now } = {}) {
  /** @type {{ state: unknown, key: string|null, closed: boolean, at: number }[]} */
  let past = [];
  /** @type {unknown[]} */
  let future = [];

  /** Marks the top entry closed so the next push starts a fresh coalescing run. */
  function closeTop() {
    if (past.length) past[past.length - 1].closed = true;
  }

  /**
   * Records `before` (the state prior to a change). Consecutive changes sharing a non-null
   * `coalesceKey` within `coalesceMs` of each other merge into one entry, so typing a word
   * undoes as a unit while the first keystroke's "before" state is what gets restored.
   */
  function push(before, { coalesceKey = null } = {}) {
    const t = now();
    const top = past[past.length - 1];
    future = [];
    if (coalesceKey != null && top && top.key === coalesceKey && !top.closed && t - top.at <= coalesceMs) {
      top.at = t;
      return;
    }
    past.push({ state: before, key: coalesceKey, closed: false, at: t });
    while (past.length > limit) past.shift();
  }

  /** Pops the most recent "before" state; `current` becomes redoable. Returns null when nothing to undo. */
  function undo(current) {
    closeTop();
    const entry = past.pop();
    if (!entry) return null;
    future.push(current);
    return entry.state;
  }

  /** Mirror of undo: `current` becomes undoable (as a closed entry). Returns null when nothing to redo. */
  function redo(current) {
    closeTop();
    if (!future.length) return null;
    const next = future.pop();
    past.push({ state: current, key: null, closed: true, at: now() });
    return next;
  }

  function clear() {
    closeTop();
    past = [];
    future = [];
  }

  return {
    push,
    undo,
    redo,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    breakCoalescing: closeTop,
    clear,
  };
}
