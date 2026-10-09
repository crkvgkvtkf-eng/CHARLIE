// Auto-sync scheduler and status (SPEC §7.3). Sits between the store and js/sync.js: debounces
// store changes into sync runs, serialises runs (one in flight, a request during the flight marks
// it dirty and re-runs once), re-merges edits the user made while a run was in flight, keeps the
// sync config (`ssb.sync.v1`: token, login, gistId, synced) through the injected load/save hooks,
// and exposes a status for the sync dot and Settings › Sync.
//
// Construction touches no globals: window/document/navigator are handed to `start()`, and the
// timers use the global setTimeout so node:test mock timers work.
import * as sync from './sync.js';
import { serializeExport } from './storage.js';

export const DEBOUNCE_MS = 2500;
export const MIN_RATELIMIT_BACKOFF_MS = 60_000;
export const GIST_SCOPE_MESSAGE = "This token can't access gists. Create a classic token with the gist scope.";
export const AUTH_ERROR_MESSAGE = 'GitHub rejected the token — reconnect in Settings';

const EMPTY_CONFIG = Object.freeze({ token: null, login: null, gistId: null, synced: {} });

/** A SyncError of the given kind, built so it works with the real SyncError and any stand-in. */
function syncError(kind, message) {
  const err = new sync.SyncError(message);
  err.kind = kind;
  return err;
}

/** The persisted config, with every field present whatever loadConfig returned. */
function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    token: typeof cfg.token === 'string' && cfg.token !== '' ? cfg.token : null,
    login: typeof cfg.login === 'string' ? cfg.login : null,
    gistId: typeof cfg.gistId === 'string' && cfg.gistId !== '' ? cfg.gistId : null,
    synced: cfg.synced && typeof cfg.synced === 'object' ? { ...cfg.synced } : {},
  };
}

/**
 * @param {object} deps
 * @param {object} deps.store                 the js/store.js store
 * @param {() => object|null} deps.loadConfig  reads `ssb.sync.v1`
 * @param {(cfg: object) => void} deps.saveConfig
 * @param {Function} [deps.createClient]
 * @param {Function} [deps.runSync]
 * @param {Function} [deps.merge]
 * @param {() => number} [deps.now]            millisecond clock
 * @param {(names: string[]) => void} [deps.onConflictCopies]   called with the names of conflict copies a run created (UI toasts them)
 */
export function createSyncManager({
  store,
  loadConfig,
  saveConfig,
  createClient = sync.createClient,
  runSync = sync.runSync,
  merge = sync.merge,
  now = Date.now,
  onConflictCopies = () => {},
}) {
  let cfg = normalizeConfig(loadConfig());
  const listeners = new Set();

  let client = null; // cached per token
  let clientToken = null;
  let inFlight = null; // promise of the run (or connect) currently executing
  let connecting = false; // connect()'s trial sync is running (there may be no saved token yet)
  let dirty = false; // a sync was requested while one was in flight
  let generation = 0; // bumped by disconnect: a run started before it discards its outcome
  let lastError = null; // { kind, message } of the last failed run, null after a success
  let lastSyncAt = null;
  let retryNotBefore = 0; // ms timestamp: no automatic run before this (rate limit backoff)
  let debounceTimer = null;

  // Set by start(), cleared by stop().
  let nav = null;
  let detachListeners = null;

  // ---------------------------------------------------------------------------
  // Status

  function state() {
    if (connecting) return 'syncing';
    if (!cfg.token) return 'off';
    if (inFlight) return 'syncing';
    if (nav?.onLine === false || lastError?.kind === 'network') return 'offline';
    if (lastError) return 'error';
    return 'idle';
  }

  function getStatus() {
    return {
      state: state(),
      lastSyncAt,
      error: lastError?.message ?? null,
      errorKind: lastError?.kind ?? null,
      login: cfg.login,
      gistId: cfg.gistId,
    };
  }

  function notify() {
    const status = getStatus();
    for (const fn of [...listeners]) fn(status);
  }

  function isoNow() {
    return new Date(now()).toISOString();
  }

  function clientFor(token) {
    if (!client || clientToken !== token) {
      client = createClient({ token });
      clientToken = token;
    }
    return client;
  }

  function recordFailure(err) {
    const kind = err?.kind ?? 'other';
    let message = err?.message || String(err);
    if (kind === 'auth') message = AUTH_ERROR_MESSAGE;
    if (kind === 'ratelimit') retryNotBefore = now() + Math.max(err?.retryAfterMs ?? 0, MIN_RATELIMIT_BACKOFF_MS);
    lastError = { kind, message };
  }

  function recordSuccess() {
    lastError = null;
    retryNotBefore = 0;
    lastSyncAt = isoNow();
  }

  // ---------------------------------------------------------------------------
  // One sync run (SPEC §7.3 "Applying a sync result")

  /**
   * Runs one sync against `config` (token, gistId, synced) and applies the result to the store.
   * Returns the config to save; throws the SyncError on failure. Edits the user made while the
   * run was in flight are re-merged into the result instead of being discarded.
   */
  async function runOnce(config) {
    const gen = generation;
    const base = store.get();
    const r = await runSync({ client: clientFor(config.token), workspace: base, gistId: config.gistId, synced: config.synced });
    if (gen !== generation) return null; // disconnected meanwhile: the result is stale
    let ws = r.workspace;
    let localChanged = r.localChanged;
    const conflictCopies = [...(r.conflictCopies || [])];
    const latest = store.get();
    if (latest !== base) {
      const m = merge(latest, ws, { synced: r.synced });
      ws = m.workspace;
      localChanged = m.localChanged;
      conflictCopies.push(...(m.conflictCopies || []));
      dirty = true; // the follow-up run pushes the re-merged state
    }
    // A push-only run must not touch the store, so undo history and subscribers stay untouched.
    if (localChanged) store.replace(ws, { source: 'sync', resetHistory: false });
    if (conflictCopies.length) onConflictCopies(conflictCopies);
    return { ...config, gistId: r.gistId, synced: r.synced };
  }

  /** Serialises `task` behind the in-flight guard and keeps the status at 'syncing' meanwhile. */
  async function withFlight(task) {
    while (inFlight) await inFlight.catch(() => {});
    const run = (async () => {
      try {
        return await task();
      } finally {
        inFlight = null;
      }
    })();
    inFlight = run;
    notify();
    try {
      return await run;
    } finally {
      notify();
    }
  }

  // ---------------------------------------------------------------------------
  // Public operations

  function syncNow() {
    if (!cfg.token) return Promise.resolve();
    if (inFlight) {
      dirty = true;
      return inFlight.catch(() => {});
    }
    return withFlight(async () => {
      do {
        dirty = false;
        try {
          const next = await runOnce(cfg);
          if (next === null) return; // disconnected during the run
          cfg = next;
          saveConfig(cfg);
          recordSuccess();
        } catch (err) {
          recordFailure(err);
          return; // no automatic re-run after a failure
        }
      } while (dirty && cfg.token);
    });
  }

  function cancelScheduled() {
    if (debounceTimer === null) return false;
    clearTimeout(debounceTimer);
    debounceTimer = null;
    return true;
  }

  function scheduleSync() {
    if (!cfg.token || lastError?.kind === 'auth') return;
    if (nav?.onLine === false || lastError?.kind === 'network') return;
    cancelScheduled();
    const delay = Math.max(DEBOUNCE_MS, retryNotBefore - now());
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      syncNow();
    }, delay);
  }

  async function connect(token) {
    const candidateToken = String(token ?? '').trim();
    if (!candidateToken) throw syncError('auth', 'Enter a token first.');
    const candidateClient = createClient({ token: candidateToken });
    const who = await candidateClient.whoami();
    const scopes = Array.isArray(who?.scopes) ? who.scopes : [];
    if (scopes.length && !scopes.includes('gist')) throw syncError('auth', GIST_SCOPE_MESSAGE);
    await withFlight(async () => {
      // Reuse the candidate client for the trial sync; it becomes the cached client on success.
      client = candidateClient;
      clientToken = candidateToken;
      connecting = true;
      try {
        const next = await runOnce({ ...cfg, token: candidateToken, login: who?.login ?? null });
        if (next === null) throw syncError('other', 'Sync was cancelled.');
        cfg = next;
        saveConfig(cfg);
        recordSuccess();
      } catch (err) {
        // Config stays untouched; drop the cached client so the saved token gets a fresh one.
        client = null;
        clientToken = null;
        throw err;
      } finally {
        connecting = false;
      }
    });
  }

  function disconnect() {
    generation++;
    cancelScheduled();
    dirty = false;
    cfg = { ...EMPTY_CONFIG, synced: cfg.synced }; // `synced` survives so a reconnect merges correctly
    saveConfig(cfg);
    client = null;
    clientToken = null;
    lastError = null;
    notify();
  }

  async function replaceRemote() {
    if (!cfg.token) throw syncError('auth', 'Connect to GitHub first.');
    await withFlight(async () => {
      const gen = generation;
      const ws = store.get();
      const content = serializeExport(ws);
      const api = clientFor(cfg.token);
      try {
        let gistId = cfg.gistId;
        if (gistId) {
          try {
            await api.writeGist(gistId, content);
          } catch (err) {
            if (err?.kind !== 'notfound') throw err;
            gistId = null; // the gist is gone: find or create one below
          }
        }
        if (!gistId) {
          const found = await api.findGist();
          if (found) {
            gistId = found.id;
            await api.writeGist(gistId, content);
          } else {
            gistId = (await api.createGist(content)).id;
          }
        }
        if (gen !== generation) return;
        cfg = { ...cfg, gistId, synced: sync.syncedMapOf(ws) };
        saveConfig(cfg);
        recordSuccess();
      } catch (err) {
        if (gen === generation) recordFailure(err);
        throw err;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Triggers (SPEC §7.3)

  function start({ win = globalThis.window, doc = globalThis.document, nav: navigator = globalThis.navigator } = {}) {
    stop();
    nav = navigator ?? null;
    const unsubscribeStore = store.subscribe((_ws, meta) => {
      if (meta?.source !== 'sync') scheduleSync();
    });
    const onOnline = () => { syncNow(); };
    const onOffline = () => { notify(); };
    const onVisibility = () => {
      if (doc.visibilityState === 'visible') syncNow();
      else if (doc.visibilityState === 'hidden' && cancelScheduled()) syncNow(); // best effort before the page goes away
    };
    if (win?.addEventListener) {
      win.addEventListener('online', onOnline);
      win.addEventListener('offline', onOffline);
    }
    if (doc?.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
    detachListeners = () => {
      unsubscribeStore();
      if (win?.removeEventListener) {
        win.removeEventListener('online', onOnline);
        win.removeEventListener('offline', onOffline);
      }
      if (doc?.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
    };
    if (cfg.token) syncNow();
  }

  function stop() {
    cancelScheduled();
    if (detachListeners) {
      detachListeners();
      detachListeners = null;
    }
    nav = null;
  }

  return {
    getStatus,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    connect,
    disconnect,
    syncNow,
    scheduleSync,
    replaceRemote,
    start,
    stop,
  };
}
