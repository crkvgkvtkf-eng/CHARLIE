// Unit tests for js/storage.js (SPEC §6, §13).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setClock, setIdFactory } from '../../js/ids.js';
import * as M from '../../js/model.js';
import {
  STORAGE_KEY, SYNC_KEY, loadWorkspace, saveWorkspace, serializeExport, parseImport,
} from '../../js/storage.js';

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

/** In-memory stand-in for window.localStorage. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    keys: () => [...map.keys()],
  };
}

const TOKEN = 'ghp_secret_token_value';
const syncConfig = JSON.stringify({ token: TOKEN, login: 'me', gistId: 'g1', synced: {} });

describe('constants', () => {
  test('keys', () => {
    assert.equal(STORAGE_KEY, 'ssb.workspace.v1');
    assert.equal(SYNC_KEY, 'ssb.sync.v1');
  });
});

describe('loadWorkspace', () => {
  test('missing → a fresh workspace, nothing written', () => {
    const storage = memoryStorage();
    const ws = loadWorkspace(storage);
    assert.equal(ws.versions.length, 1);
    assert.equal(ws.versions[0].name, 'Set v1');
    assert.equal(storage.length, 0);
  });
  test('round-trips a saved workspace through normalize', () => {
    const storage = memoryStorage();
    const ws = M.createWorkspace();
    const t = M.addTopic(ws, { title: 'Cats' });
    const j = M.addJoke(ws, t, { text: 'hello' });
    M.addToSet(ws, j);
    assert.equal(saveWorkspace(ws, storage), true);
    const loaded = loadWorkspace(storage);
    assert.equal(M.stableJson(loaded), M.stableJson(ws));
  });
  test('repairs a partially broken but parseable workspace in place', () => {
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ versions: [{ id: 'v', topics: [{ id: 't', collapsed: true, jokes: [] }] }], settings: { wpm: 'x' } }) });
    const ws = loadWorkspace(storage);
    assert.equal(ws.versions[0].id, 'v');
    assert.equal('collapsed' in ws.versions[0].topics[0], false);
    assert.equal(ws.settings.wpm, 140);
    assert.equal(storage.length, 1, 'no corrupt backup for repairable data');
  });
  for (const [label, raw] of [
    ['corrupt JSON', '{"versions": [ oops'],
    ['a JSON string', '"just a string"'],
    ['a JSON array', '[1,2,3]'],
    ['JSON null', 'null'],
  ]) {
    test(`${label} → fresh workspace and a corrupt backup key holding the raw text`, () => {
      const storage = memoryStorage({ [STORAGE_KEY]: raw, [SYNC_KEY]: syncConfig });
      const ws = loadWorkspace(storage);
      assert.equal(ws.versions.length, 1);
      assert.equal(ws.versions[0].topics.length, 0);
      const backupKeys = storage.keys().filter((k) => k.startsWith('ssb.workspace.corrupt.'));
      assert.equal(backupKeys.length, 1);
      assert.equal(storage.getItem(backupKeys[0]), raw);
      assert.equal(storage.getItem(STORAGE_KEY), raw, 'the original entry is left alone');
      assert.equal(storage.getItem(SYNC_KEY), syncConfig, 'sync config untouched');
    });
  }
  test('two corrupt loads at different times create distinct backup keys', () => {
    const storage = memoryStorage({ [STORAGE_KEY]: '{bad' });
    loadWorkspace(storage);
    loadWorkspace(storage);
    assert.equal(storage.keys().filter((k) => k.startsWith('ssb.workspace.corrupt.')).length, 2);
  });
  test('storage that throws on read behaves like a first run', () => {
    const storage = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
    assert.equal(loadWorkspace(storage).versions.length, 1);
  });
  test('a corrupt entry whose backup cannot be written still yields a fresh workspace', () => {
    const storage = { getItem: () => '{bad', setItem() { throw new Error('QuotaExceededError'); } };
    assert.equal(loadWorkspace(storage).versions.length, 1);
  });
});

describe('saveWorkspace', () => {
  test('writes JSON under STORAGE_KEY and returns true', () => {
    const storage = memoryStorage();
    const ws = M.createWorkspace();
    assert.equal(saveWorkspace(ws, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), JSON.parse(JSON.stringify(ws)));
  });
  test('returns false when setItem throws or storage is unavailable', () => {
    const throwing = { setItem() { throw new Error('QuotaExceededError'); } };
    assert.equal(saveWorkspace(M.createWorkspace(), throwing), false);
    assert.equal(saveWorkspace(M.createWorkspace(), undefined), false);
    assert.equal(saveWorkspace(M.createWorkspace(), null), false);
  });
});

describe('serializeExport', () => {
  test('pretty envelope with app, exportedAt and the workspace; never the sync config', () => {
    const storage = memoryStorage({ [SYNC_KEY]: syncConfig });
    const ws = M.createWorkspace();
    saveWorkspace(ws, storage);
    const text = serializeExport(loadWorkspace(storage));
    assert.ok(text.includes('\n  '), 'pretty-printed');
    const env = JSON.parse(text);
    assert.equal(env.app, 'standup-set-builder');
    assert.equal(typeof env.exportedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(env.exportedAt)));
    assert.deepEqual(Object.keys(env).sort(), ['app', 'exportedAt', 'workspace']);
    assert.equal(M.stableJson(env.workspace), M.stableJson(ws));
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes('gistId'), false);
    assert.equal(text.includes(SYNC_KEY), false);
  });
});

describe('parseImport', () => {
  test('accepts the export envelope', () => {
    const ws = M.createWorkspace();
    const t = M.addTopic(ws, { title: 'Cats' });
    M.addJoke(ws, t, { text: 'hi' });
    const imported = parseImport(serializeExport(ws));
    assert.equal(M.stableJson(imported), M.stableJson(ws));
  });
  test('accepts a bare workspace and normalizes it', () => {
    const imported = parseImport(JSON.stringify({ versions: [{ id: 'v', name: 'Only', set: { jokeIds: ['x'] } }] }));
    assert.equal(imported.versions[0].name, 'Only');
    assert.deepEqual(imported.versions[0].set.jokeIds, []);
    assert.equal(imported.activeVersionId, 'v');
    assert.equal(imported.schemaVersion, 1);
  });
  test('round-trips export → import for a rich workspace', () => {
    const ws = M.createWorkspace();
    const t = M.addTopic(ws, { title: 'Cats', color: '#f00' });
    const j = M.addJoke(ws, t, { title: 'A', text: 'one two' });
    const alt = M.addAlt(ws, j, { text: 'alt' });
    M.setActiveAlt(ws, j, alt);
    M.addToSet(ws, j);
    M.addVersion(ws);
    M.deleteVersion(ws, ws.versions[0].id);
    M.updateSettings(ws, { wpm: 180, theme: 'dark' });
    assert.equal(M.stableJson(parseImport(serializeExport(ws))), M.stableJson(ws));
  });
  test('rejects invalid JSON with a human message', () => {
    assert.throws(() => parseImport('{nope'), { message: /not valid JSON/ });
    assert.throws(() => parseImport(''), { message: /not valid JSON/ });
  });
  for (const [label, text] of [
    ['a string', '"hello"'],
    ['a number', '42'],
    ['null', 'null'],
    ['an array', '[]'],
    ['an object without versions', '{"app":"standup-set-builder"}'],
    ['versions that is not an array', '{"versions":{}}'],
    ['an envelope wrapping a bad workspace', '{"app":"standup-set-builder","workspace":{"versions":"x"}}'],
    ['an envelope wrapping a non-object', '{"app":"standup-set-builder","workspace":"x"}'],
  ]) {
    test(`rejects ${label}`, () => {
      assert.throws(() => parseImport(text), (err) => err instanceof Error && /Stand-Up Set Builder export/.test(err.message));
    });
  }
  test('rejects non-string input without crashing', () => {
    assert.throws(() => parseImport(undefined), Error);
    assert.throws(() => parseImport({ versions: [] }), Error);
  });
});
