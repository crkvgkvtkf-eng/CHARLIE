// Unit tests for js/store.js (SPEC §8, §13 "store" bullets). The id factory and clock are
// deterministic; the persist debounce is driven with node:test mock timers.
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setClock, setIdFactory, nowIso } from '../../js/ids.js';
import * as M from '../../js/model.js';
import { createHistory } from '../../js/undo.js';
import { createStore, coalesceKeyFor } from '../../js/store.js';

let tick;
let idCounter;
beforeEach(() => {
  tick = 0;
  idCounter = 0;
  setClock(() => new Date(Date.UTC(2024, 0, 1) + ++tick * 1000)); // strictly increasing
  setIdFactory(() => `id${++idCounter}`);
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => {
  mock.timers.reset();
  setClock(null);
  setIdFactory(null);
});

/** A store over a fresh workspace with a recording persist hook and subscriber. */
function makeStore(options = {}) {
  const saved = [];
  const events = [];
  const errors = [];
  const store = createStore(M.createWorkspace(), {
    persist: (ws) => { saved.push(ws); return true; },
    onPersistError: (err) => errors.push(err),
    ...options,
  });
  store.subscribe((ws, meta) => events.push({ ws, meta }));
  return { store, saved, events, errors };
}

/** Seeds one topic with one joke; returns their ids. */
function seed(store) {
  const topicId = store.actions.addTopic({ title: 'Cats' });
  const jokeId = store.actions.addJoke(topicId, { title: 'Litter', text: 'My cat pays rent' });
  return { topicId, jokeId };
}

describe('apply', () => {
  test('runs the mutator on a clone, adopts the result, notifies with source user and returns the value', () => {
    const { store, events } = makeStore();
    const before = store.get();
    const id = store.apply('add topic', (d) => M.addTopic(d, { title: 'A' }));
    assert.equal(id, 'id3');
    assert.notEqual(store.get(), before, 'a new snapshot');
    assert.equal(before.versions[0].topics.length, 0, 'the previous snapshot is untouched');
    assert.equal(store.get().versions[0].topics[0].title, 'A');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].meta, { source: 'user', label: 'add topic' });
    assert.equal(events[0].ws, store.get());
    assert.equal(store.canUndo(), true);
  });

  test('a no-op mutation pushes nothing, persists nothing and does not notify', () => {
    const history = createHistory();
    const pushes = [];
    const originalPush = history.push;
    history.push = (...args) => { pushes.push(args); return originalPush(...args); };
    const { store, saved, events } = makeStore({ history });
    const { jokeId } = seed(store);
    store.actions.addToSet(jokeId);
    mock.timers.tick(1000);
    const snapshot = store.get();
    const savedCount = saved.length;
    const eventCount = events.length;
    const pushCount = pushes.length;

    store.actions.addToSet(jokeId, 0); // already in the set: no-op even with an index
    const result = store.apply('nothing', () => 42);
    mock.timers.tick(1000);
    assert.equal(result, 42);
    assert.equal(store.get(), snapshot, 'snapshot identity unchanged');
    assert.equal(saved.length, savedCount);
    assert.equal(events.length, eventCount);
    assert.equal(pushes.length, pushCount, 'no extra history entries');
  });

  test('a throwing mutator leaves the state unchanged and propagates', () => {
    const { store, events } = makeStore();
    const snapshot = store.get();
    assert.throws(() => store.apply('bad', (d) => M.removeTopic(d, 'nope')), /Unknown topic/);
    assert.throws(() => store.apply('bad', (d) => { d.versions[0].name = 'changed'; throw new Error('boom'); }), /boom/);
    assert.equal(store.get(), snapshot);
    assert.equal(store.get().versions[0].name, 'Set v1');
    assert.equal(events.length, 0);
    assert.equal(store.canUndo(), false);
  });

  test('snapshots are not shared with the draft: mutating the mutator result cannot change the store', () => {
    const { store } = makeStore();
    seed(store);
    const topic = store.apply('peek', (d) => d.versions[0].topics[0]);
    topic.title = 'hacked';
    assert.equal(store.get().versions[0].topics[0].title, 'Cats');
  });
});

describe('actions', () => {
  test('binds every model mutation from SPEC §3.1 and nothing else', () => {
    const { store } = makeStore();
    const expected = [
      'addTopic', 'updateTopic', 'removeTopic', 'moveTopic',
      'addJoke', 'updateJoke', 'removeJoke', 'duplicateJoke', 'moveJoke',
      'addAlt', 'updateAlt', 'removeAlt', 'moveAlt', 'setActiveAlt', 'promoteAlt',
      'addToSet', 'removeFromSet', 'toggleInSet', 'moveInSet',
      'addVersion', 'renameVersion', 'deleteVersion', 'switchVersion',
      'updateSettings',
    ].sort();
    assert.deepEqual(Object.keys(store.actions).sort(), expected);
    for (const name of expected) assert.equal(typeof store.actions[name], 'function', name);
  });

  test('bound actions apply with the mutation name as label and return the mutation result', () => {
    const { store, events } = makeStore();
    const { jokeId } = seed(store);
    assert.equal(store.actions.toggleInSet(jokeId), true);
    assert.equal(M.isInSet(store.get(), jokeId), true);
    assert.equal(events.at(-1).meta.label, 'toggleInSet');
    assert.throws(() => store.actions.removeJoke('nope'), /Unknown joke/);
  });

  test('coalesce keys follow the SPEC §8 table', () => {
    assert.equal(coalesceKeyFor('updateJoke', ['j1', { text: 'x' }]), 'joke:text:j1');
    assert.equal(coalesceKeyFor('updateJoke', ['j1', { title: 'x' }]), 'joke:title:j1');
    assert.equal(coalesceKeyFor('updateJoke', ['j1', { notes: 'x' }]), 'joke:notes:j1');
    assert.equal(coalesceKeyFor('updateJoke', ['j1', { overrideSec: 3 }]), null);
    assert.equal(coalesceKeyFor('updateTopic', ['t1', { title: 'x' }]), 'topic:title:t1');
    assert.equal(coalesceKeyFor('updateTopic', ['t1', { color: 'red' }]), null);
    assert.equal(coalesceKeyFor('updateAlt', ['a1', { text: 'x' }]), 'alt:text:a1');
    assert.equal(coalesceKeyFor('renameVersion', ['v1', 'Name']), 'version:name:v1');
    assert.equal(coalesceKeyFor('updateSettings', [{ wpm: 150 }]), 'settings');
    assert.equal(coalesceKeyFor('addTopic', [{ title: 'x' }]), null);
    assert.equal(coalesceKeyFor('moveInSet', ['j1', 0]), null);
  });

  test('typing into one field coalesces into a single undo step; breakCoalescing splits it', () => {
    const { store } = makeStore();
    const { jokeId } = seed(store);
    store.actions.updateJoke(jokeId, { text: 'a' });
    store.actions.updateJoke(jokeId, { text: 'ab' });
    store.actions.updateJoke(jokeId, { text: 'abc' });
    store.breakCoalescing();
    store.actions.updateJoke(jokeId, { text: 'abc\n' });
    store.actions.updateJoke(jokeId, { text: 'abc\nd' });
    const textOf = () => M.findJoke(store.get(), jokeId).joke.text;
    assert.equal(textOf(), 'abc\nd');
    assert.equal(store.undo(), true);
    assert.equal(textOf(), 'abc');
    assert.equal(store.undo(), true);
    assert.equal(textOf(), 'My cat pays rent');
    // Edits to different fields never merge.
    store.actions.updateJoke(jokeId, { text: 'x' });
    store.actions.updateJoke(jokeId, { title: 'y' });
    assert.equal(store.undo(), true);
    assert.equal(M.findJoke(store.get(), jokeId).joke.title, 'Litter');
    assert.equal(textOf(), 'x');
  });
});

describe('undo / redo', () => {
  test('undo restores the previous content, redo re-applies it; both report availability', () => {
    const { store, events } = makeStore();
    const { topicId } = seed(store);
    assert.equal(store.canUndo(), true);
    assert.equal(store.canRedo(), false);
    assert.equal(store.undo(), true);
    assert.equal(M.findTopic(store.get(), topicId).topic.jokes.length, 0);
    assert.deepEqual(events.at(-1).meta, { source: 'undo', label: 'undo' });
    assert.equal(store.canRedo(), true);
    assert.equal(store.redo(), true);
    assert.equal(M.findTopic(store.get(), topicId).topic.jokes.length, 1);
    assert.deepEqual(events.at(-1).meta, { source: 'redo', label: 'redo' });
    assert.equal(store.undo(), true);
    assert.equal(store.undo(), true);
    assert.equal(store.get().versions[0].topics.length, 0);
    assert.equal(store.undo(), false, 'nothing left');
    assert.equal(store.redo(), true);
    assert.equal(store.redo(), true);
    assert.equal(store.redo(), false);
  });

  test('undo stamping: the restored version carries a NEW updatedAt so the undone content wins a later LWW merge', () => {
    const { store } = makeStore();
    const { jokeId } = seed(store);
    const original = store.get();
    const versionId = original.activeVersionId;
    store.actions.updateJoke(jokeId, { text: 'edited' });
    const edited = store.get();
    const editedAt = edited.versions[0].updatedAt;
    assert.ok(editedAt > original.versions[0].updatedAt);

    assert.equal(store.undo(), true);
    const restored = store.get();
    assert.equal(M.findJoke(restored, jokeId).joke.text, 'My cat pays rent', 'content restored');
    assert.ok(restored.versions[0].updatedAt > editedAt, 'updatedAt advanced past the edit it undid');
    assert.ok(restored.updatedAt > edited.updatedAt);
    // A later-updatedAt version wins rule 2 of the merge, so the undone state beats the pushed edit.
    const lww = [edited, restored].map((ws) => ws.versions.find((v) => v.id === versionId)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    assert.equal(M.findJoke({ ...restored, versions: [lww], activeVersionId: versionId }, jokeId).joke.text, 'My cat pays rent');
    // The history entry itself was not modified: the original snapshot keeps its old timestamp.
    assert.equal(original.versions[0].updatedAt < editedAt, true);
    assert.equal(store.redo(), true, 'redo still works');
    assert.equal(M.findJoke(store.get(), jokeId).joke.text, 'edited');
    assert.ok(store.get().versions[0].updatedAt > restored.versions[0].updatedAt, 'redo stamps too');
  });

  test('stamping touches only what differs: set.updatedAt only for set changes, settingsUpdatedAt only for settings', () => {
    const { store } = makeStore();
    const { jokeId } = seed(store);
    store.actions.addVersion({ name: 'Other', fromVersionId: null }); // a second, untouched version
    store.actions.switchVersion(store.get().versions[0].id);
    const idle = store.get();
    const otherId = idle.versions[1].id;

    // Set change: set.updatedAt and updatedAt of that version are stamped on undo; the other version is not.
    store.actions.addToSet(jokeId);
    const added = store.get();
    assert.equal(store.undo(), true);
    let ws = store.get();
    assert.ok(ws.versions[0].set.updatedAt > added.versions[0].set.updatedAt);
    assert.equal(ws.versions.find((v) => v.id === otherId).updatedAt, idle.versions[1].updatedAt, 'untouched version keeps its timestamp');
    assert.equal(ws.settingsUpdatedAt, added.settingsUpdatedAt, 'settings not stamped');
    store.redo();

    // Text change: version.updatedAt stamped, set.updatedAt not.
    store.actions.updateJoke(jokeId, { text: 'new' });
    const texted = store.get();
    assert.equal(store.undo(), true);
    ws = store.get();
    assert.ok(ws.versions[0].updatedAt > texted.versions[0].updatedAt);
    assert.equal(ws.versions[0].set.updatedAt, texted.versions[0].set.updatedAt);
    store.redo();

    // Settings change: settingsUpdatedAt stamped, versions untouched.
    store.actions.updateSettings({ wpm: 200 });
    const paced = store.get();
    assert.equal(store.undo(), true);
    ws = store.get();
    assert.equal(ws.settings.wpm, 140);
    assert.ok(ws.settingsUpdatedAt > paced.settingsUpdatedAt);
    assert.equal(ws.versions[0].updatedAt, paced.versions[0].updatedAt);
    assert.ok(ws.updatedAt > paced.updatedAt, 'ws.updatedAt always advances');
  });

  test('undo of a deleteVersion restores the version and the tombstones as they were', () => {
    const { store } = makeStore();
    store.actions.addVersion({ name: 'Two' });
    const twoId = store.get().activeVersionId;
    store.actions.deleteVersion(twoId);
    assert.equal(typeof store.get().tombstones[twoId], 'string');
    assert.equal(store.undo(), true);
    const ws = store.get();
    assert.equal(ws.versions.length, 2);
    assert.deepEqual(ws.tombstones, {});
    assert.equal(ws.activeVersionId, twoId);
  });

  test('uses the injected `now` clock for stamps', () => {
    let n = 0;
    const { store } = makeStore({ now: () => `2030-01-01T00:00:0${++n}.000Z` });
    seed(store);
    store.undo();
    assert.equal(store.get().updatedAt, '2030-01-01T00:00:01.000Z');
  });
});

describe('replace', () => {
  test('normalizes, resets history by default, persists immediately and notifies with source replace', () => {
    const { store, saved, events } = makeStore();
    seed(store);
    mock.timers.tick(1000);
    const savedCount = saved.length;
    const raw = { versions: [{ id: 'v9', name: 'Imported', topics: [{ id: 't', collapsed: true, jokes: [] }] }] };
    store.replace(raw);
    assert.equal(store.get(), raw, 'the normalized object becomes the snapshot');
    assert.equal(store.get().schemaVersion, 1);
    assert.equal('collapsed' in store.get().versions[0].topics[0], false);
    assert.equal(saved.length, savedCount + 1, 'persisted synchronously');
    assert.equal(saved.at(-1), raw);
    assert.deepEqual(events.at(-1).meta, { source: 'replace', label: 'replace' });
    assert.equal(store.canUndo(), false);
    assert.equal(store.canRedo(), false);
    mock.timers.tick(1000);
    assert.equal(saved.length, savedCount + 1, 'no second debounced save');
  });

  test('resetHistory: false keeps the previous state undoable as a closed entry', () => {
    const { store, events } = makeStore();
    const { jokeId } = seed(store);
    store.actions.updateJoke(jokeId, { text: 'typing' });
    const before = store.get();
    const incoming = structuredClone(before);
    M.updateJoke(incoming, jokeId, { text: 'from sync' });
    store.replace(incoming, { source: 'sync', resetHistory: false });
    assert.equal(events.at(-1).meta.source, 'sync');
    assert.equal(M.findJoke(store.get(), jokeId).joke.text, 'from sync');
    // Continuing to type with the same key must not merge into the closed entry.
    store.actions.updateJoke(jokeId, { text: 'typing more' });
    assert.equal(store.undo(), true);
    assert.equal(M.findJoke(store.get(), jokeId).joke.text, 'from sync');
    assert.equal(store.undo(), true);
    assert.equal(M.findJoke(store.get(), jokeId).joke.text, 'typing');
  });

  test('source import is passed through to subscribers', () => {
    const { store, events } = makeStore();
    store.replace(M.createWorkspace(), { source: 'import' });
    assert.deepEqual(events.at(-1).meta, { source: 'import', label: 'import' });
  });
});

describe('persist', () => {
  test('apply debounces one save per burst (default 150 ms) with the latest snapshot', () => {
    const { store, saved } = makeStore();
    const { jokeId } = seed(store);
    store.actions.updateJoke(jokeId, { text: 'a' });
    assert.equal(saved.length, 0);
    mock.timers.tick(149);
    assert.equal(saved.length, 0);
    mock.timers.tick(1);
    assert.equal(saved.length, 1);
    assert.equal(saved[0], store.get());
    mock.timers.tick(10_000);
    assert.equal(saved.length, 1);
  });

  test('custom debounceMs', () => {
    const { store, saved } = makeStore({ debounceMs: 1000 });
    seed(store);
    mock.timers.tick(999);
    assert.equal(saved.length, 0);
    mock.timers.tick(1);
    assert.equal(saved.length, 1);
  });

  test('flush writes immediately and is a no-op when nothing is pending', () => {
    const { store, saved } = makeStore();
    store.flush();
    assert.equal(saved.length, 0);
    seed(store);
    store.flush();
    assert.equal(saved.length, 1);
    assert.equal(saved[0], store.get());
    store.flush();
    mock.timers.tick(1000);
    assert.equal(saved.length, 1, 'the pending timer was consumed by flush');
  });

  test('undo and redo schedule a persist', () => {
    const { store, saved } = makeStore();
    seed(store);
    mock.timers.tick(150);
    store.undo();
    mock.timers.tick(150);
    assert.equal(saved.length, 2);
    store.redo();
    mock.timers.tick(150);
    assert.equal(saved.length, 3);
    assert.equal(saved[2], store.get());
  });

  test('a throwing persist still updates state and notifies; the error goes to onPersistError', () => {
    const { store, events, errors } = makeStore({ persist: () => { throw new Error('quota'); } });
    const { topicId } = seed(store);
    mock.timers.tick(150);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /quota/);
    assert.equal(events.length, 2);
    assert.equal(M.findTopic(store.get(), topicId).topic.title, 'Cats');
    store.replace(M.createWorkspace());
    assert.equal(errors.length, 2, 'immediate persist on replace is reported too');
    assert.equal(events.length, 3);
  });

  test('a persist returning false is reported as an error', () => {
    const { store, errors } = makeStore({ persist: () => false });
    seed(store);
    store.flush();
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
  });

  test('persist and onPersistError default to safe values', () => {
    const store = createStore(M.createWorkspace(), { history: createHistory() });
    assert.doesNotThrow(() => { store.actions.addTopic({ title: 'x' }); store.flush(); });
  });
});

describe('subscribe', () => {
  test('unsubscribe stops notifications; subscribers see the snapshot that get() returns', () => {
    const { store } = makeStore();
    const seen = [];
    const off = store.subscribe((ws) => seen.push(ws));
    store.actions.addTopic({ title: 'A' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0], store.get());
    off();
    store.actions.addTopic({ title: 'B' });
    assert.equal(seen.length, 1);
  });

  test('timestamps in snapshots come from the model clock', () => {
    const { store } = makeStore();
    seed(store);
    assert.match(store.get().updatedAt, /^2024-01-01T00:00:0\d\.000Z$/);
    assert.ok(nowIso() > store.get().updatedAt, 'the fake clock keeps increasing');
  });
});

describe('regressions', () => {
  test('typing right after an undo never merges into the entry below the undone one', () => {
    const { store } = makeStore();
    const { jokeId } = seed(store);
    const textOf = () => M.findJoke(store.get(), jokeId).joke.text;
    store.actions.updateJoke(jokeId, { text: 'a' });
    store.actions.updateJoke(jokeId, { text: 'ab' });
    store.actions.updateJoke(jokeId, { title: 'Other field' });
    assert.equal(store.undo(), true);
    assert.equal(textOf(), 'ab');
    store.actions.updateJoke(jokeId, { text: 'abc' }); // same key, within the idle window
    assert.equal(store.undo(), true);
    assert.equal(textOf(), 'ab', 'the post-undo keystroke is its own undo step');
    assert.equal(store.undo(), true);
    assert.equal(textOf(), 'My cat pays rent');
  });

  test('redo of a deletion re-stamps the restored tombstone so the deletion wins a later merge', () => {
    const { store } = makeStore();
    store.actions.addVersion({ name: 'Two' });
    const twoId = store.get().activeVersionId;
    store.actions.deleteVersion(twoId);
    const deletedAt = store.get().tombstones[twoId];
    assert.equal(store.undo(), true);
    const revived = store.get().versions.find((v) => v.id === twoId);
    assert.ok(revived.updatedAt > deletedAt, 'the undo stamped the revived version past the tombstone');
    assert.equal(store.redo(), true);
    const ws = store.get();
    assert.equal(ws.versions.some((v) => v.id === twoId), false);
    assert.ok(ws.tombstones[twoId] > revived.updatedAt, 'the tombstone is newer than the revived version it deletes');
    assert.equal(ws.tombstones[twoId], ws.updatedAt);
    // Undoing again drops the tombstone as it was (no tombstone before the deletion).
    assert.equal(store.undo(), true);
    assert.deepEqual(store.get().tombstones, {});
  });
});
