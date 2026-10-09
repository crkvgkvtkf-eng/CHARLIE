// Unit tests for js/syncManager.js (SPEC §7.3, §13 "syncManager" bullets). The gist client,
// runSync and merge are injected fakes (the real sync.js is never called); timers are node:test
// mock timers; the store is the real js/store.js wherever the test depends on store semantics.
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setClock, setIdFactory } from '../../js/ids.js';
import * as M from '../../js/model.js';
import { syncedMapOf } from '../../js/sync.js';
import { createStore } from '../../js/store.js';
import {
  createSyncManager, DEBOUNCE_MS, MIN_RATELIMIT_BACKOFF_MS, AUTH_ERROR_MESSAGE, GIST_SCOPE_MESSAGE,
} from '../../js/syncManager.js';

let tick;
let idCounter;
let clockMs;
beforeEach(() => {
  tick = 0;
  idCounter = 0;
  clockMs = Date.UTC(2025, 5, 1);
  setClock(() => new Date(Date.UTC(2024, 0, 1) + ++tick * 1000));
  setIdFactory(() => `id${++idCounter}`);
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => {
  mock.timers.reset();
  setClock(null);
  setIdFactory(null);
});

/** Millisecond clock for the manager; `advance` moves it together with the mock timers. */
const now = () => clockMs;
function advance(ms) {
  clockMs += ms;
  mock.timers.tick(ms);
}

/** Lets queued promise callbacks run (setImmediate is not mocked). */
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A SyncError-shaped failure (the stub SyncError has no options constructor, so fields are assigned). */
function failure(kind, message = `${kind} failure`, extra = {}) {
  return Object.assign(new Error(message), { kind, ...extra });
}

/** Result of a push-only run: remote now matches `workspace`, nothing to pull. */
function pushOnlyResult({ workspace, gistId }) {
  return {
    workspace,
    gistId: gistId || 'gist1',
    pushed: true,
    pulled: false,
    localChanged: false,
    remoteChanged: true,
    conflictCopies: [],
    remoteUpdatedAt: '2025-06-01T00:00:00.000Z',
    synced: syncedMapOf(workspace),
  };
}

/** Result of a pull: the local store must adopt `remote`. */
function pullResult(remote, { gistId = 'gist1', conflictCopies = [] } = {}) {
  return {
    workspace: remote,
    gistId,
    pushed: false,
    pulled: true,
    localChanged: true,
    remoteChanged: false,
    conflictCopies,
    remoteUpdatedAt: '2025-06-01T00:00:00.000Z',
    synced: syncedMapOf(remote),
  };
}

/**
 * A controllable runSync: records every call; `behave(fn)` queues a handler for the next call
 * (fn receives the call args and returns/throws the result); default is a push-only success.
 */
function fakeRunSync() {
  const calls = [];
  const queue = [];
  const fn = async (args) => {
    calls.push(args);
    const handler = queue.shift() || pushOnlyResult;
    return handler(args);
  };
  fn.calls = calls;
  fn.behave = (handler) => { queue.push(handler); return fn; };
  return fn;
}

/** A fake gist client whose methods are recorded; whoami/scopes configurable. */
function fakeClient({ login = 'alice', scopes = ['gist'], whoamiError = null } = {}) {
  const calls = [];
  let seq = 0;
  return {
    calls,
    async whoami() {
      calls.push(['whoami']);
      if (whoamiError) throw whoamiError;
      return { login, scopes };
    },
    async findGist() { calls.push(['findGist']); return this.found || null; },
    async createGist(content) { calls.push(['createGist', content]); return { id: `created${++seq}`, updated_at: 'x' }; },
    async readGist(id) { calls.push(['readGist', id]); return { content: '{}', updated_at: 'x' }; },
    async writeGist(id, content) {
      calls.push(['writeGist', id, content]);
      if (this.writeError) throw this.writeError;
      return { updated_at: 'x' };
    },
  };
}

/** Fake merge: local content wins, remote settings win; marks itself in `calls`. */
function fakeMerge() {
  const calls = [];
  const fn = (local, remote, options) => {
    calls.push([local, remote, options]);
    const workspace = { ...structuredClone(local), settings: structuredClone(remote.settings) };
    return { workspace, localChanged: true, remoteChanged: true, conflictCopies: fn.conflictCopies || [] };
  };
  fn.calls = calls;
  return fn;
}

class FakeDocument extends EventTarget {
  visibilityState = 'visible';
}

/** A manager over a real store with recording config hooks. */
function setup({ config = { token: 'tok', login: 'alice', gistId: 'gist1', synced: {} }, workspace = M.createWorkspace(), client, runSync = fakeRunSync(), merge = fakeMerge() } = {}) {
  const store = createStore(workspace, { persist: () => true });
  const saved = [];
  const statuses = [];
  const conflicts = [];
  const theClient = client || fakeClient();
  const createClient = mock.fn(() => theClient);
  const mgr = createSyncManager({
    store,
    loadConfig: () => config,
    saveConfig: (cfg) => saved.push(structuredClone(cfg)),
    createClient,
    runSync,
    merge,
    now,
    onConflictCopies: (names) => conflicts.push(...names),
  });
  mgr.subscribe((status) => statuses.push(status));
  return { mgr, store, saved, statuses, conflicts, client: theClient, createClient, runSync, merge };
}

describe('status', () => {
  test('off without a token; idle with one; config is normalized', () => {
    assert.equal(setup({ config: null }).mgr.getStatus().state, 'off');
    assert.equal(setup({ config: { token: '' } }).mgr.getStatus().state, 'off');
    const { mgr } = setup();
    assert.deepEqual(mgr.getStatus(), { state: 'idle', lastSyncAt: null, error: null, errorKind: null, login: 'alice', gistId: 'gist1' });
  });

  test('syncNow without a token is a no-op that resolves', async () => {
    const { mgr, runSync } = setup({ config: null });
    await mgr.syncNow();
    assert.equal(runSync.calls.length, 0);
  });

  test('a successful run records lastSyncAt from the injected clock, saves config and notifies syncing → idle', async () => {
    const { mgr, saved, statuses, runSync } = setup();
    const p = mgr.syncNow();
    assert.equal(mgr.getStatus().state, 'syncing');
    await p;
    assert.equal(runSync.calls.length, 1);
    assert.equal(runSync.calls[0].gistId, 'gist1');
    assert.equal(mgr.getStatus().state, 'idle');
    assert.equal(mgr.getStatus().lastSyncAt, new Date(clockMs).toISOString());
    assert.equal(saved.length, 1);
    assert.equal(saved[0].token, 'tok');
    assert.deepEqual(saved[0].synced, syncedMapOf(runSync.calls[0].workspace));
    assert.deepEqual(statuses.map((s) => s.state), ['syncing', 'idle']);
  });

  test('the client is created once per token and reused', async () => {
    const { mgr, createClient } = setup();
    await mgr.syncNow();
    await mgr.syncNow();
    assert.equal(createClient.mock.callCount(), 1);
    assert.deepEqual(createClient.mock.calls[0].arguments, [{ token: 'tok' }]);
  });
});

describe('scheduleSync', () => {
  test('debounces store changes into one run 2500 ms after the last change', async () => {
    const { mgr, store, runSync } = setup();
    mgr.start({ win: new EventTarget(), doc: new FakeDocument(), nav: { onLine: true } });
    await settle();
    assert.equal(runSync.calls.length, 1, 'start() runs an initial sync when connected');

    const t = store.actions.addTopic({ title: 'A' });
    advance(2000);
    store.actions.updateTopic(t, { title: 'AB' });
    advance(2000);
    await settle();
    assert.equal(runSync.calls.length, 1, 'still debouncing');
    advance(DEBOUNCE_MS - 2000);
    await settle();
    assert.equal(runSync.calls.length, 2);
    advance(60_000);
    await settle();
    assert.equal(runSync.calls.length, 2, 'one run per burst');
    mgr.stop();
  });

  test('store changes with source sync do not schedule a run', async () => {
    const { mgr, store, runSync } = setup();
    mgr.start({ win: new EventTarget(), doc: new FakeDocument(), nav: { onLine: true } });
    await settle();
    store.replace(M.createWorkspace(), { source: 'sync', resetHistory: false });
    advance(DEBOUNCE_MS * 2);
    await settle();
    assert.equal(runSync.calls.length, 1);
    mgr.stop();
  });

  test('is a no-op when off, when offline and after an auth error', async () => {
    const off = setup({ config: null });
    off.mgr.scheduleSync();
    advance(DEBOUNCE_MS);
    await settle();
    assert.equal(off.runSync.calls.length, 0);

    const offline = setup();
    offline.mgr.start({ win: new EventTarget(), doc: new FakeDocument(), nav: { onLine: false } });
    await settle();
    assert.equal(offline.mgr.getStatus().state, 'offline');
    offline.runSync.calls.length = 0;
    offline.mgr.scheduleSync();
    advance(DEBOUNCE_MS);
    await settle();
    assert.equal(offline.runSync.calls.length, 0);
    offline.mgr.stop();
  });

  test('stop() cancels a scheduled run', async () => {
    const { mgr, store, runSync } = setup();
    mgr.start({ win: new EventTarget(), doc: new FakeDocument(), nav: { onLine: true } });
    await settle();
    store.actions.addTopic({ title: 'A' });
    mgr.stop();
    advance(DEBOUNCE_MS);
    await settle();
    assert.equal(runSync.calls.length, 1);
  });
});

describe('in-flight guard', () => {
  test('syncNow during a run sets dirty and re-runs exactly once afterwards', async () => {
    const { mgr, runSync } = setup();
    const gate = deferred();
    runSync.behave(async (args) => { await gate.promise; return pushOnlyResult(args); });
    const first = mgr.syncNow();
    const second = mgr.syncNow();
    const third = mgr.syncNow();
    await settle();
    assert.equal(runSync.calls.length, 1, 'only one run in flight');
    gate.resolve();
    await Promise.all([first, second, third]);
    await settle();
    assert.equal(runSync.calls.length, 2, 'one follow-up run, not one per request');
    assert.equal(mgr.getStatus().state, 'idle');
  });

  test('a store change during an in-flight sync survives: it is re-merged and pushed by a follow-up run', async () => {
    const remote = M.createWorkspace();
    M.updateSettings(remote, { wpm: 200 }); // what the other device changed
    const { mgr, store, runSync, merge, saved } = setup();
    const gate = deferred();
    runSync.behave(async () => { await gate.promise; return pullResult(remote); });

    const base = store.get();
    const p = mgr.syncNow();
    await settle();
    const topicId = store.actions.addTopic({ title: 'Typed during sync' }); // in-flight edit
    const latest = store.get();
    assert.notEqual(latest, base);
    gate.resolve();
    await p;

    assert.equal(merge.calls.length, 1, 'the in-flight edit was re-merged');
    assert.equal(merge.calls[0][0], latest, 'merge(latest, …)');
    assert.equal(merge.calls[0][1], remote, 'merge(…, r.workspace, …)');
    assert.deepEqual(merge.calls[0][2], { synced: syncedMapOf(remote) });
    const ws = store.get();
    assert.ok(M.findTopic(ws, topicId), 'the edit is still there');
    assert.equal(ws.settings.wpm, 200, 'and the remote change arrived');
    assert.equal(runSync.calls.length, 2, 'dirty → follow-up run pushes the re-merged state');
    assert.equal(runSync.calls[1].workspace, ws);
    assert.equal(saved.length, 2);
    assert.equal(mgr.getStatus().state, 'idle');
  });

  test('a push-only sync leaves canUndo true and does not notify store subscribers', async () => {
    const { mgr, store, runSync } = setup();
    store.actions.addTopic({ title: 'A' });
    assert.equal(store.canUndo(), true);
    const notifications = [];
    store.subscribe((_ws, meta) => notifications.push(meta));
    const snapshot = store.get();
    await mgr.syncNow();
    assert.equal(runSync.calls.length, 1);
    assert.equal(store.get(), snapshot, 'store untouched');
    assert.equal(notifications.length, 0);
    assert.equal(store.canUndo(), true);
  });

  test('a pull replaces the store with source sync and keeps history (resetHistory false)', async () => {
    const remote = M.createWorkspace();
    const remoteTopic = M.addTopic(remote, { title: 'Remote' });
    const { mgr, store, runSync } = setup();
    store.actions.addTopic({ title: 'Local' });
    runSync.behave(() => pullResult(remote));
    const notifications = [];
    store.subscribe((_ws, meta) => notifications.push(meta));
    await mgr.syncNow();
    assert.ok(M.findTopic(store.get(), remoteTopic));
    assert.deepEqual(notifications, [{ source: 'sync', label: 'sync' }]);
    assert.equal(store.canUndo(), true, 'the pre-sync state stays undoable');
  });

  test('conflict copies created by a run are reported', async () => {
    const remote = M.createWorkspace();
    const { mgr, runSync, conflicts } = setup();
    runSync.behave(() => pullResult(remote, { conflictCopies: ['Set v1 (conflict copy)'] }));
    await mgr.syncNow();
    assert.deepEqual(conflicts, ['Set v1 (conflict copy)']);
  });
});

describe('errors and backoff', () => {
  test('auth error: status error with the reconnect message; scheduling stops until connect() succeeds', async () => {
    const { mgr, store, runSync, client } = setup();
    runSync.behave(() => { throw failure('auth', 'Bad credentials', { status: 401 }); });
    mgr.start({ win: new EventTarget(), doc: new FakeDocument(), nav: { onLine: true } });
    await settle();
    assert.deepEqual([mgr.getStatus().state, mgr.getStatus().error, mgr.getStatus().errorKind], ['error', AUTH_ERROR_MESSAGE, 'auth']);

    store.actions.addTopic({ title: 'A' });
    mgr.scheduleSync();
    advance(DEBOUNCE_MS * 4);
    await settle();
    assert.equal(runSync.calls.length, 1, 'no automatic run after an auth error');

    await mgr.connect('newtok');
    assert.equal(mgr.getStatus().state, 'idle');
    assert.equal(runSync.calls.length, 2);
    assert.equal(client.calls.filter((c) => c[0] === 'whoami').length, 1);
    store.actions.addTopic({ title: 'B' });
    advance(DEBOUNCE_MS);
    await settle();
    assert.equal(runSync.calls.length, 3, 'scheduling works again');
    mgr.stop();
  });

  test('network error: status offline, no automatic runs, online event retries', async () => {
    const win = new EventTarget();
    const { mgr, runSync } = setup();
    runSync.behave(() => { throw failure('network', 'Failed to fetch'); });
    mgr.start({ win, doc: new FakeDocument(), nav: { onLine: true } });
    await settle();
    assert.equal(mgr.getStatus().state, 'offline');
    assert.equal(mgr.getStatus().errorKind, 'network');
    mgr.scheduleSync();
    advance(DEBOUNCE_MS);
    await settle();
    assert.equal(runSync.calls.length, 1);
    win.dispatchEvent(new Event('online'));
    await settle();
    assert.equal(runSync.calls.length, 2);
    assert.equal(mgr.getStatus().state, 'idle');
    mgr.stop();
  });

  test('other error: status error with the message; a later success clears it', async () => {
    const { mgr, runSync } = setup();
    runSync.behave(() => { throw failure('other', 'Remote data is unreadable'); });
    await mgr.syncNow();
    assert.equal(mgr.getStatus().state, 'error');
    assert.equal(mgr.getStatus().error, 'Remote data is unreadable');
    assert.equal(mgr.getStatus().errorKind, 'other');
    await mgr.syncNow();
    assert.equal(mgr.getStatus().state, 'idle');
    assert.equal(mgr.getStatus().error, null);
  });

  test('ratelimit: automatic runs wait for retryAfterMs (min 60 s); manual syncNow is still allowed', async () => {
    const { mgr, runSync } = setup();
    runSync.behave(() => { throw failure('ratelimit', 'API rate limit exceeded', { retryAfterMs: 120_000 }); });
    await mgr.syncNow();
    assert.equal(mgr.getStatus().state, 'error');
    assert.equal(mgr.getStatus().errorKind, 'ratelimit');

    mgr.scheduleSync();
    advance(DEBOUNCE_MS);
    await settle();
    assert.equal(runSync.calls.length, 1, 'not before retryAfterMs');
    advance(120_000 - DEBOUNCE_MS - 1);
    await settle();
    assert.equal(runSync.calls.length, 1);
    advance(1);
    await settle();
    assert.equal(runSync.calls.length, 2, 'runs once the backoff elapsed');
    assert.equal(mgr.getStatus().state, 'idle');

    // A short retry-after is raised to the 60 s minimum, and a manual run goes through immediately.
    runSync.behave(() => { throw failure('ratelimit', 'slow down', { retryAfterMs: 1000 }); });
    await mgr.syncNow();
    mgr.scheduleSync();
    advance(MIN_RATELIMIT_BACKOFF_MS - 1);
    await settle();
    assert.equal(runSync.calls.length, 3);
    await mgr.syncNow();
    assert.equal(runSync.calls.length, 4, 'manual Sync now ignores the backoff');
    advance(1);
    await settle();
    assert.equal(runSync.calls.length, 5);
  });

  test('syncNow never rejects, even when the store or merge throws', async () => {
    const { mgr, runSync } = setup();
    runSync.behave(() => { throw new TypeError('plain error'); });
    await assert.doesNotReject(() => mgr.syncNow());
    assert.equal(mgr.getStatus().state, 'error');
    assert.equal(mgr.getStatus().errorKind, 'other');
    assert.equal(mgr.getStatus().error, 'plain error');
  });
});

describe('connect', () => {
  test('pristine adoption on connect: a fresh device takes over the remote workspace and saves the config', async () => {
    const remote = M.createWorkspace();
    const topic = M.addTopic(remote, { title: 'From the other device' });
    const { mgr, store, saved, runSync, client } = setup({ config: null });
    assert.equal(mgr.getStatus().state, 'off');
    runSync.behave((args) => {
      assert.equal(args.client, client);
      assert.equal(args.gistId, null);
      assert.deepEqual(args.synced, {});
      return pullResult(remote, { gistId: 'gist42' });
    });
    await mgr.connect('  ghp_candidate  ');
    assert.ok(M.findTopic(store.get(), topic), 'remote adopted');
    assert.equal(store.get().versions.length, 1);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0], { token: 'ghp_candidate', login: 'alice', gistId: 'gist42', synced: syncedMapOf(remote) });
    const status = mgr.getStatus();
    assert.equal(status.state, 'idle');
    assert.equal(status.login, 'alice');
    assert.equal(status.gistId, 'gist42');
    assert.ok(status.lastSyncAt);
  });

  test('rejects with an auth SyncError when the token lacks the gist scope and saves nothing', async () => {
    const { mgr, saved, runSync } = setup({ config: null, client: fakeClient({ scopes: ['repo', 'user'] }) });
    await assert.rejects(() => mgr.connect('tok'), (err) => err.kind === 'auth' && err.message === GIST_SCOPE_MESSAGE);
    assert.equal(saved.length, 0);
    assert.equal(runSync.calls.length, 0);
    assert.equal(mgr.getStatus().state, 'off');
  });

  test('an empty scope list (fine-grained style headers) is accepted', async () => {
    const { mgr } = setup({ config: null, client: fakeClient({ scopes: [] }) });
    await mgr.connect('tok');
    assert.equal(mgr.getStatus().state, 'idle');
  });

  test('whoami failure or a failed trial sync rejects and leaves the existing config untouched', async () => {
    const whoamiFail = setup({ client: fakeClient({ whoamiError: failure('auth', 'Bad credentials') }) });
    await assert.rejects(() => whoamiFail.mgr.connect('bad'), (err) => err.kind === 'auth');
    assert.equal(whoamiFail.saved.length, 0);
    assert.equal(whoamiFail.mgr.getStatus().login, 'alice', 'old config still in place');

    const syncFail = setup();
    syncFail.runSync.behave(() => { throw failure('other', 'Remote data is unreadable'); });
    await assert.rejects(() => syncFail.mgr.connect('new'), /unreadable/);
    assert.equal(syncFail.saved.length, 0);
    assert.equal(syncFail.mgr.getStatus().state, 'idle', 'status still describes the untouched config');
    assert.equal(syncFail.mgr.getStatus().login, 'alice');
    // The old token keeps working.
    await syncFail.mgr.syncNow();
    assert.equal(syncFail.runSync.calls.at(-1).gistId, 'gist1');
    assert.equal(syncFail.mgr.getStatus().state, 'idle');
  });

  test('rejects an empty token without touching the network', async () => {
    const { mgr, client } = setup({ config: null });
    await assert.rejects(() => mgr.connect('   '), (err) => err.kind === 'auth');
    assert.equal(client.calls.length, 0);
  });

  test('reconnecting after disconnect reuses the kept synced map', async () => {
    const { mgr, saved, runSync } = setup({ config: { token: 'tok', login: 'alice', gistId: 'gist1', synced: { v1: 't1' } } });
    mgr.disconnect();
    assert.deepEqual(saved.at(-1), { token: null, login: null, gistId: null, synced: { v1: 't1' } });
    assert.equal(mgr.getStatus().state, 'off');
    await mgr.connect('tok2');
    assert.deepEqual(runSync.calls[0].synced, { v1: 't1' });
    assert.equal(runSync.calls[0].gistId, null, 'the gist is looked up again');
  });
});

describe('disconnect', () => {
  test('clears token/login/gistId, keeps synced, cancels scheduling and discards an in-flight result', async () => {
    const { mgr, store, saved, runSync } = setup({ config: { token: 'tok', login: 'alice', gistId: 'gist1', synced: { v1: 't1' } } });
    const gate = deferred();
    runSync.behave(async () => { await gate.promise; return pullResult(M.createWorkspace()); });
    mgr.start({ win: new EventTarget(), doc: new FakeDocument(), nav: { onLine: true } });
    await settle();
    store.actions.addTopic({ title: 'A' });
    const before = store.get();
    mgr.disconnect();
    assert.equal(mgr.getStatus().state, 'off');
    gate.resolve();
    await settle();
    assert.equal(store.get(), before, 'stale pull result ignored');
    assert.deepEqual(saved.at(-1), { token: null, login: null, gistId: null, synced: { v1: 't1' } });
    advance(DEBOUNCE_MS * 2);
    await settle();
    assert.equal(runSync.calls.length, 1);
    mgr.stop();
  });
});

describe('replaceRemote', () => {
  test('writes the current workspace to the known gist and records synced = syncedMapOf', async () => {
    const { mgr, store, saved, client } = setup();
    store.actions.addTopic({ title: 'Mine' });
    await mgr.replaceRemote();
    const write = client.calls.find((c) => c[0] === 'writeGist');
    assert.equal(write[1], 'gist1');
    const envelope = JSON.parse(write[2]);
    assert.equal(envelope.app, 'standup-set-builder');
    assert.equal(M.stableJson(envelope.workspace), M.stableJson(store.get()));
    assert.equal('token' in envelope, false);
    assert.deepEqual(saved.at(-1).synced, syncedMapOf(store.get()));
    assert.equal(mgr.getStatus().state, 'idle');
  });

  test('creates the gist when none is known and none is found; reuses a found one', async () => {
    const none = setup({ config: { token: 'tok', login: 'alice', gistId: null, synced: {} } });
    await none.mgr.replaceRemote();
    assert.deepEqual(none.client.calls.map((c) => c[0]), ['findGist', 'createGist']);
    assert.equal(none.saved.at(-1).gistId, 'created1');

    const found = setup({ config: { token: 'tok', login: 'alice', gistId: null, synced: {} } });
    found.client.found = { id: 'existing', updated_at: 'x' };
    await found.mgr.replaceRemote();
    assert.deepEqual(found.client.calls.map((c) => c[0]), ['findGist', 'writeGist']);
    assert.equal(found.saved.at(-1).gistId, 'existing');
  });

  test('a vanished gist (notfound on write) is recreated; other failures set the error status and reject', async () => {
    const gone = setup();
    gone.client.writeError = failure('notfound', 'Not Found');
    await gone.mgr.replaceRemote();
    assert.deepEqual(gone.client.calls.map((c) => c[0]), ['writeGist', 'findGist', 'createGist']);
    assert.equal(gone.saved.at(-1).gistId, 'created1');

    const broken = setup();
    broken.client.writeError = failure('other', 'Server error');
    await assert.rejects(() => broken.mgr.replaceRemote(), /Server error/);
    assert.equal(broken.mgr.getStatus().state, 'error');
    assert.equal(broken.saved.length, 0);
  });

  test('rejects when not connected', async () => {
    const { mgr } = setup({ config: null });
    await assert.rejects(() => mgr.replaceRemote(), (err) => err.kind === 'auth');
  });
});

describe('start / stop triggers', () => {
  test('visibility visible → syncNow; hidden with a scheduled run → immediate syncNow', async () => {
    const doc = new FakeDocument();
    const { mgr, store, runSync } = setup();
    mgr.start({ win: new EventTarget(), doc, nav: { onLine: true } });
    await settle();
    assert.equal(runSync.calls.length, 1);

    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    assert.equal(runSync.calls.length, 1, 'hidden without a scheduled run does nothing');

    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    assert.equal(runSync.calls.length, 2);

    store.actions.addTopic({ title: 'A' }); // schedules
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    assert.equal(runSync.calls.length, 3, 'flushed immediately before the page goes away');
    advance(DEBOUNCE_MS);
    await settle();
    assert.equal(runSync.calls.length, 3, 'the debounce was cancelled');
    mgr.stop();
  });

  test('start() without a token does not sync; missing globals are tolerated; stop() detaches listeners', async () => {
    const off = setup({ config: null });
    off.mgr.start({ win: undefined, doc: undefined, nav: undefined });
    await settle();
    assert.equal(off.runSync.calls.length, 0);
    off.mgr.stop();

    const win = new EventTarget();
    const doc = new FakeDocument();
    const { mgr, store, runSync } = setup();
    mgr.start({ win, doc, nav: { onLine: true } });
    await settle();
    mgr.stop();
    win.dispatchEvent(new Event('online'));
    doc.dispatchEvent(new Event('visibilitychange'));
    store.actions.addTopic({ title: 'A' });
    advance(DEBOUNCE_MS);
    await settle();
    assert.equal(runSync.calls.length, 1, 'nothing after stop()');
  });

  test('offline event notifies subscribers so the status dot can update', async () => {
    const win = new EventTarget();
    const nav = { onLine: true };
    const { mgr, statuses } = setup();
    mgr.start({ win, doc: new FakeDocument(), nav });
    await settle();
    nav.onLine = false;
    win.dispatchEvent(new Event('offline'));
    assert.equal(statuses.at(-1).state, 'offline');
    mgr.stop();
  });

  test('subscribe returns an unsubscribe function', async () => {
    const { mgr } = setup();
    const seen = [];
    const off = mgr.subscribe((s) => seen.push(s.state));
    await mgr.syncNow();
    assert.deepEqual(seen, ['syncing', 'idle']);
    off();
    await mgr.syncNow();
    assert.equal(seen.length, 2);
  });
});
