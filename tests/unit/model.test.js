// Unit tests for js/model.js (SPEC §3, §13).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setClock, setIdFactory } from '../../js/ids.js';
import * as M from '../../js/model.js';

const EPOCH = '1970-01-01T00:00:00.000Z';
let tick;
let idCounter;

beforeEach(() => {
  // Strictly increasing fake clock (1 s steps from a fixed origin) and a counter id factory.
  tick = 0;
  idCounter = 0;
  setClock(() => new Date(Date.UTC(2024, 0, 1) + ++tick * 1000));
  setIdFactory(() => `id${++idCounter}`);
});
afterEach(() => {
  setClock(null);
  setIdFactory(null);
});

/** Workspace with one topic holding three jokes ("a", "b", "c") and one alt on joke "a". */
function fixture() {
  const ws = M.createWorkspace();
  const topicId = M.addTopic(ws, { title: 'Cats' });
  const a = M.addJoke(ws, topicId, { title: 'A', text: 'joke a' });
  const b = M.addJoke(ws, topicId, { title: 'B', text: 'joke b' });
  const c = M.addJoke(ws, topicId, { title: 'C', text: 'joke c' });
  const altA = M.addAlt(ws, a, { text: 'alt of a' });
  return { ws, topicId, a, b, c, altA };
}

const jokeIdsOf = (ws, topicId) => M.findTopic(ws, topicId).topic.jokes.map((j) => j.id);
const topicIdsOf = (ws) => M.activeVersion(ws).topics.map((t) => t.id);
const setOf = (ws) => M.activeVersion(ws).set.jokeIds;

describe('stableJson', () => {
  test('sorts keys recursively and leaves arrays in order', () => {
    const text = M.stableJson({ b: [{ z: 1, y: 2 }], a: { d: null, c: 'x' } });
    assert.equal(text, '{"a":{"c":"x","d":null},"b":[{"y":2,"z":1}]}');
  });
  test('equal content with different key order gives equal text', () => {
    assert.equal(M.stableJson({ x: 1, y: { p: 1, q: 2 } }), M.stableJson({ y: { q: 2, p: 1 }, x: 1 }));
  });
  test('handles primitives', () => {
    assert.equal(M.stableJson('s'), '"s"');
    assert.equal(M.stableJson(null), 'null');
    assert.equal(M.stableJson(undefined), undefined);
  });
});

describe('createWorkspace / createVersion', () => {
  test('fresh workspace has defaults and one empty version that is active', () => {
    const ws = M.createWorkspace();
    assert.equal(ws.schemaVersion, 1);
    assert.deepEqual(ws.settings, { wpm: 140, pauseSec: 2, targetSec: 300, theme: 'system', colWidth: 360 });
    assert.equal(ws.versions.length, 1);
    assert.equal(ws.versions[0].name, 'Set v1');
    assert.deepEqual(ws.versions[0].topics, []);
    assert.deepEqual(ws.versions[0].set.jokeIds, []);
    assert.equal(ws.activeVersionId, ws.versions[0].id);
    assert.deepEqual(ws.tombstones, {});
    assert.equal(M.normalize(structuredClone(ws)) && M.stableJson(M.normalize(structuredClone(ws))), M.stableJson(ws));
  });
  test('createVersion({ from }) deep-copies with fresh ids and remaps set + activeAltId', () => {
    const { ws, a, altA } = fixture();
    M.addToSet(ws, a);
    M.setActiveAlt(ws, a, altA);
    const src = M.activeVersion(ws);
    const copy = M.createVersion({ name: 'Copy', from: src });
    assert.equal(copy.name, 'Copy');
    assert.notEqual(copy.id, src.id);
    const copyJoke = copy.topics[0].jokes[0];
    assert.notEqual(copy.topics[0].id, src.topics[0].id);
    assert.notEqual(copyJoke.id, a);
    assert.notEqual(copyJoke.alts[0].id, altA);
    assert.equal(copyJoke.activeAltId, copyJoke.alts[0].id);
    assert.deepEqual(copy.set.jokeIds, [copyJoke.id]);
    assert.equal(copyJoke.text, 'joke a');
    // Nothing shared by reference with the source.
    copy.topics[0].jokes[0].text = 'changed';
    assert.equal(src.topics[0].jokes[0].text, 'joke a');
  });
});

describe('lookup', () => {
  test('findTopic/findJoke/findAlt return positions or null', () => {
    const { ws, topicId, b, altA, a } = fixture();
    assert.equal(M.findTopic(ws, topicId).index, 0);
    assert.equal(M.findJoke(ws, b).index, 1);
    assert.equal(M.findJoke(ws, b).topicIndex, 0);
    assert.equal(M.findJoke(ws, b).topic.id, topicId);
    assert.equal(M.findAlt(ws, altA).joke.id, a);
    assert.equal(M.findAlt(ws, altA).index, 0);
    assert.equal(M.findTopic(ws, 'nope'), null);
    assert.equal(M.findJoke(ws, 'nope'), null);
    assert.equal(M.findAlt(ws, 'nope'), null);
  });
  test('lookups only see the active version', () => {
    const { ws, a } = fixture();
    M.addVersion(ws, { fromVersionId: null });
    assert.equal(M.findJoke(ws, a), null);
    assert.throws(() => M.updateJoke(ws, a, { text: 'x' }), /Unknown joke/);
  });
  test('deliveredText falls back to the joke text when activeAltId is null or dangling', () => {
    const joke = { text: 'own', alts: [{ id: 'x', text: 'alt' }], activeAltId: null };
    assert.equal(M.deliveredText(joke), 'own');
    joke.activeAltId = 'x';
    assert.equal(M.deliveredText(joke), 'alt');
    joke.activeAltId = 'missing';
    assert.equal(M.deliveredText(joke), 'own');
  });
});

describe('timestamps', () => {
  test('mutations stamp version.updatedAt and ws.updatedAt; set changes also stamp set.updatedAt', () => {
    const { ws, topicId, a } = fixture();
    const v = M.activeVersion(ws);
    const before = { v: v.updatedAt, ws: ws.updatedAt, set: v.set.updatedAt };
    M.updateTopic(ws, topicId, { title: 'Dogs' });
    assert.ok(v.updatedAt > before.v);
    assert.ok(ws.updatedAt > before.ws);
    assert.equal(v.set.updatedAt, before.set);
    M.addToSet(ws, a);
    assert.ok(v.set.updatedAt > before.set);
    assert.equal(v.set.updatedAt, v.updatedAt);
  });
  test('updateSettings stamps settingsUpdatedAt and updatedAt only', () => {
    const ws = M.createWorkspace();
    const vUpdated = ws.versions[0].updatedAt;
    const before = ws.settingsUpdatedAt;
    M.updateSettings(ws, { wpm: 200 });
    assert.equal(ws.settings.wpm, 200);
    assert.ok(ws.settingsUpdatedAt > before);
    assert.equal(ws.updatedAt, ws.settingsUpdatedAt);
    assert.equal(ws.versions[0].updatedAt, vUpdated);
  });
});

describe('topics', () => {
  test('addTopic appends by default, inserts at a clamped index otherwise', () => {
    const ws = M.createWorkspace();
    const t1 = M.addTopic(ws, { title: 'one' });
    const t2 = M.addTopic(ws, { title: 'two' });
    const t0 = M.addTopic(ws, { title: 'zero', color: 'red' }, 0);
    const tLast = M.addTopic(ws, {}, 99);
    const tNeg = M.addTopic(ws, {}, -5);
    assert.deepEqual(topicIdsOf(ws), [tNeg, t0, t1, t2, tLast]);
    const topic = M.findTopic(ws, t0).topic;
    assert.deepEqual(topic, { id: t0, title: 'zero', color: 'red', jokes: [] });
  });
  test('updateTopic patches title/color and throws on unknown id', () => {
    const { ws, topicId } = fixture();
    M.updateTopic(ws, topicId, { color: '#abc' });
    assert.equal(M.findTopic(ws, topicId).topic.color, '#abc');
    assert.equal(M.findTopic(ws, topicId).topic.title, 'Cats');
    M.updateTopic(ws, topicId, { title: 'Dogs', color: null });
    assert.equal(M.findTopic(ws, topicId).topic.title, 'Dogs');
    assert.equal(M.findTopic(ws, topicId).topic.color, null);
    assert.throws(() => M.updateTopic(ws, 'nope', { title: 'x' }), /Unknown topic/);
  });
  test('removeTopic drops its jokes from the set and stamps the set', () => {
    const { ws, topicId, a, c } = fixture();
    const other = M.addTopic(ws, { title: 'Other' });
    const d = M.addJoke(ws, other, { text: 'd' });
    M.addToSet(ws, a);
    M.addToSet(ws, d);
    M.addToSet(ws, c);
    const setBefore = M.activeVersion(ws).set.updatedAt;
    M.removeTopic(ws, topicId);
    assert.deepEqual(topicIdsOf(ws), [other]);
    assert.deepEqual(setOf(ws), [d]);
    assert.ok(M.activeVersion(ws).set.updatedAt > setBefore);
    assert.throws(() => M.removeTopic(ws, topicId), /Unknown topic/);
  });
  test('moveTopic uses the index after removal and clamps', () => {
    const ws = M.createWorkspace();
    const ids = [M.addTopic(ws), M.addTopic(ws), M.addTopic(ws), M.addTopic(ws)];
    M.moveTopic(ws, ids[0], 2); // [1,2,0,3]
    assert.deepEqual(topicIdsOf(ws), [ids[1], ids[2], ids[0], ids[3]]);
    M.moveTopic(ws, ids[3], 0);
    assert.deepEqual(topicIdsOf(ws), [ids[3], ids[1], ids[2], ids[0]]);
    M.moveTopic(ws, ids[3], 100);
    assert.deepEqual(topicIdsOf(ws), [ids[1], ids[2], ids[0], ids[3]]);
    M.moveTopic(ws, ids[1], undefined);
    assert.deepEqual(topicIdsOf(ws), [ids[2], ids[0], ids[3], ids[1]]);
    assert.throws(() => M.moveTopic(ws, 'nope', 0), /Unknown topic/);
  });
});

describe('jokes', () => {
  test('addJoke creates a complete joke, honours index, throws on unknown topic', () => {
    const { ws, topicId, a, b, c } = fixture();
    const d = M.addJoke(ws, topicId, { title: 'D' }, 1);
    assert.deepEqual(jokeIdsOf(ws, topicId), [a, d, b, c]);
    const joke = M.findJoke(ws, d).joke;
    assert.deepEqual(joke, { id: d, title: 'D', text: '', alts: [], activeAltId: null, overrideSec: null, notes: '' });
    assert.throws(() => M.addJoke(ws, 'nope'), /Unknown topic/);
  });
  test('updateJoke patches allowed fields and validates overrideSec / activeAltId', () => {
    const { ws, a, altA } = fixture();
    M.updateJoke(ws, a, { title: 'T', text: 'X', notes: 'N', overrideSec: 42, activeAltId: altA });
    const joke = M.findJoke(ws, a).joke;
    assert.equal(joke.title, 'T');
    assert.equal(joke.text, 'X');
    assert.equal(joke.notes, 'N');
    assert.equal(joke.overrideSec, 42);
    assert.equal(joke.activeAltId, altA);
    M.updateJoke(ws, a, { overrideSec: null, activeAltId: null });
    assert.equal(joke.overrideSec, null);
    assert.equal(joke.activeAltId, null);
    assert.throws(() => M.updateJoke(ws, a, { overrideSec: NaN }));
    assert.throws(() => M.updateJoke(ws, a, { overrideSec: -1 }));
    assert.throws(() => M.updateJoke(ws, a, { activeAltId: 'nope' }));
    assert.throws(() => M.updateJoke(ws, 'nope', { text: '' }), /Unknown joke/);
  });
  test('removeJoke removes from topic and set', () => {
    const { ws, topicId, a, b, c } = fixture();
    M.addToSet(ws, b);
    M.addToSet(ws, a);
    M.removeJoke(ws, b);
    assert.deepEqual(jokeIdsOf(ws, topicId), [a, c]);
    assert.deepEqual(setOf(ws), [a]);
    assert.throws(() => M.removeJoke(ws, b), /Unknown joke/);
  });
  test('duplicateJoke copies right after the source with fresh ids, not in set; editing the copy leaves the original byte-identical', () => {
    const { ws, topicId, a, b, c, altA } = fixture();
    M.addToSet(ws, a);
    M.setActiveAlt(ws, a, altA);
    M.updateJoke(ws, a, { notes: 'n', overrideSec: 7 });
    const originalBefore = M.stableJson(M.findJoke(ws, a).joke);
    const copyId = M.duplicateJoke(ws, a);
    assert.deepEqual(jokeIdsOf(ws, topicId), [a, copyId, b, c]);
    assert.equal(M.isInSet(ws, copyId), false);
    const copy = M.findJoke(ws, copyId).joke;
    assert.notEqual(copy.alts[0].id, altA);
    assert.equal(copy.activeAltId, copy.alts[0].id);
    assert.equal(copy.notes, 'n');
    assert.equal(copy.overrideSec, 7);
    M.updateJoke(ws, copyId, { text: 'edited', title: 'E' });
    M.updateAlt(ws, copy.alts[0].id, { text: 'edited alt' });
    M.removeAlt(ws, copy.alts[0].id);
    assert.equal(M.stableJson(M.findJoke(ws, a).joke), originalBefore);
    assert.throws(() => M.duplicateJoke(ws, 'nope'), /Unknown joke/);
  });
  test('moveJoke within and across topics with index-after-removal semantics', () => {
    const { ws, topicId, a, b, c } = fixture();
    M.moveJoke(ws, a, topicId, 1); // [b, a, c]
    assert.deepEqual(jokeIdsOf(ws, topicId), [b, a, c]);
    M.moveJoke(ws, c, topicId, 0);
    assert.deepEqual(jokeIdsOf(ws, topicId), [c, b, a]);
    const other = M.addTopic(ws, { title: 'Other' });
    M.addToSet(ws, b);
    M.moveJoke(ws, b, other, undefined);
    assert.deepEqual(jokeIdsOf(ws, topicId), [c, a]);
    assert.deepEqual(jokeIdsOf(ws, other), [b]);
    assert.equal(M.isInSet(ws, b), true, 'set membership survives a move');
    M.moveJoke(ws, a, other, 0);
    assert.deepEqual(jokeIdsOf(ws, other), [a, b]);
    assert.throws(() => M.moveJoke(ws, 'nope', other, 0), /Unknown joke/);
    assert.throws(() => M.moveJoke(ws, a, 'nope', 0), /Unknown topic/);
  });
});

describe('alts', () => {
  test('addAlt / updateAlt / removeAlt (resets activeAltId)', () => {
    const { ws, a, altA } = fixture();
    const alt2 = M.addAlt(ws, a, { text: 'two' }, 0);
    assert.deepEqual(M.findJoke(ws, a).joke.alts.map((x) => x.id), [alt2, altA]);
    M.updateAlt(ws, alt2, { text: 'TWO' });
    assert.equal(M.findAlt(ws, alt2).alt.text, 'TWO');
    M.setActiveAlt(ws, a, alt2);
    M.removeAlt(ws, alt2);
    assert.deepEqual(M.findJoke(ws, a).joke.alts.map((x) => x.id), [altA]);
    assert.equal(M.findJoke(ws, a).joke.activeAltId, null);
    M.setActiveAlt(ws, a, altA);
    M.addAlt(ws, a, { text: 'three' });
    M.removeAlt(ws, M.findJoke(ws, a).joke.alts[1].id);
    assert.equal(M.findJoke(ws, a).joke.activeAltId, altA, 'removing another alt keeps the active one');
    assert.throws(() => M.addAlt(ws, 'nope'), /Unknown joke/);
    assert.throws(() => M.updateAlt(ws, 'nope', { text: '' }), /Unknown alt/);
    assert.throws(() => M.removeAlt(ws, 'nope'), /Unknown alt/);
  });
  test('setActiveAlt requires the alt to belong to the joke', () => {
    const { ws, a, b, altA } = fixture();
    assert.throws(() => M.setActiveAlt(ws, b, altA));
    M.setActiveAlt(ws, a, altA);
    assert.equal(M.findJoke(ws, a).joke.activeAltId, altA);
    M.setActiveAlt(ws, a, null);
    assert.equal(M.findJoke(ws, a).joke.activeAltId, null);
    assert.throws(() => M.setActiveAlt(ws, 'nope', null), /Unknown joke/);
  });
  test('moveAlt to another joke resets the source activeAltId; within the joke keeps it', () => {
    const { ws, a, b, altA } = fixture();
    const alt2 = M.addAlt(ws, a, { text: 'two' });
    M.setActiveAlt(ws, a, altA);
    M.moveAlt(ws, altA, a, 1); // reorder within joke
    assert.deepEqual(M.findJoke(ws, a).joke.alts.map((x) => x.id), [alt2, altA]);
    assert.equal(M.findJoke(ws, a).joke.activeAltId, altA);
    M.moveAlt(ws, altA, b, 0);
    assert.equal(M.findJoke(ws, a).joke.activeAltId, null);
    assert.deepEqual(M.findJoke(ws, b).joke.alts.map((x) => x.id), [altA]);
    assert.deepEqual(M.findJoke(ws, a).joke.alts.map((x) => x.id), [alt2]);
    M.moveAlt(ws, alt2, b, undefined);
    assert.deepEqual(M.findJoke(ws, b).joke.alts.map((x) => x.id), [altA, alt2]);
    assert.throws(() => M.moveAlt(ws, 'nope', b, 0), /Unknown alt/);
    assert.throws(() => M.moveAlt(ws, altA, 'nope', 0), /Unknown joke/);
  });
  test('promoteAlt swaps texts and clears activeAltId', () => {
    const { ws, a, altA } = fixture();
    M.setActiveAlt(ws, a, altA);
    M.promoteAlt(ws, altA);
    const joke = M.findJoke(ws, a).joke;
    assert.equal(joke.text, 'alt of a');
    assert.equal(joke.alts[0].text, 'joke a');
    assert.equal(joke.activeAltId, null);
    assert.throws(() => M.promoteAlt(ws, 'nope'), /Unknown alt/);
  });
});

describe('set', () => {
  test('addToSet appends / inserts, is a no-op when present even with an index', () => {
    const { ws, a, b, c } = fixture();
    M.addToSet(ws, a);
    M.addToSet(ws, b);
    M.addToSet(ws, c, 0);
    assert.deepEqual(setOf(ws), [c, a, b]);
    const stamp = M.activeVersion(ws).updatedAt;
    M.addToSet(ws, a, 0);
    assert.deepEqual(setOf(ws), [c, a, b]);
    assert.equal(M.activeVersion(ws).updatedAt, stamp, 'no-op does not stamp');
    assert.throws(() => M.addToSet(ws, 'nope'), /Unknown joke/);
  });
  test('removeFromSet / toggleInSet / isInSet', () => {
    const { ws, a, b } = fixture();
    assert.equal(M.toggleInSet(ws, a), true);
    assert.equal(M.isInSet(ws, a), true);
    assert.equal(M.toggleInSet(ws, a), false);
    assert.equal(M.isInSet(ws, a), false);
    M.addToSet(ws, a);
    M.addToSet(ws, b);
    M.removeFromSet(ws, a);
    assert.deepEqual(setOf(ws), [b]);
    const stamp = M.activeVersion(ws).updatedAt;
    M.removeFromSet(ws, a);
    assert.equal(M.activeVersion(ws).updatedAt, stamp, 'removing an absent joke is a no-op');
    assert.equal(M.isInSet(ws, 'nope'), false);
    assert.throws(() => M.removeFromSet(ws, 'nope'), /Unknown joke/);
    assert.throws(() => M.toggleInSet(ws, 'nope'), /Unknown joke/);
  });
  test('moveInSet uses index after removal, clamps, throws when absent', () => {
    const { ws, a, b, c } = fixture();
    M.addToSet(ws, a);
    M.addToSet(ws, b);
    M.addToSet(ws, c);
    M.moveInSet(ws, a, 1);
    assert.deepEqual(setOf(ws), [b, a, c]);
    M.moveInSet(ws, c, 0);
    assert.deepEqual(setOf(ws), [c, b, a]);
    M.moveInSet(ws, c, 50);
    assert.deepEqual(setOf(ws), [b, a, c]);
    M.removeFromSet(ws, a);
    assert.throws(() => M.moveInSet(ws, a, 0), /Joke not in set/);
    assert.throws(() => M.moveInSet(ws, 'nope', 0), /Unknown joke/);
  });
});

describe('versions', () => {
  test('addVersion from the active version copies it with fresh ids and default name; becomes active', () => {
    const { ws, a } = fixture();
    M.addToSet(ws, a);
    const v2 = M.addVersion(ws);
    assert.equal(ws.activeVersionId, v2);
    const version = M.activeVersion(ws);
    assert.equal(version.name, 'Set v1 copy');
    assert.equal(version.topics[0].jokes.length, 3);
    assert.notEqual(version.topics[0].jokes[0].id, a);
    assert.deepEqual(version.set.jokeIds, [version.topics[0].jokes[0].id]);
    assert.deepEqual(ws.versions.map((v) => v.id), [ws.versions[0].id, v2], 'ordered by createdAt');
  });
  test('addVersion blank uses "Set v<N>"; explicit name wins; unknown from throws', () => {
    const ws = M.createWorkspace();
    const v2 = M.addVersion(ws, { fromVersionId: null });
    assert.equal(M.activeVersion(ws).name, 'Set v2');
    assert.deepEqual(M.activeVersion(ws).topics, []);
    M.addVersion(ws, { name: 'Named', fromVersionId: v2 });
    assert.equal(M.activeVersion(ws).name, 'Named');
    assert.throws(() => M.addVersion(ws, { fromVersionId: 'nope' }), /Unknown version/);
  });
  test('renameVersion stamps; switchVersion stamps only ws.updatedAt', () => {
    const ws = M.createWorkspace();
    const v1 = ws.versions[0].id;
    const v2 = M.addVersion(ws, { fromVersionId: null });
    M.renameVersion(ws, v1, 'First');
    assert.equal(ws.versions[0].name, 'First');
    const stamps = ws.versions.map((v) => v.updatedAt);
    const wsBefore = ws.updatedAt;
    M.switchVersion(ws, v1);
    assert.equal(ws.activeVersionId, v1);
    assert.deepEqual(ws.versions.map((v) => v.updatedAt), stamps);
    assert.ok(ws.updatedAt > wsBefore);
    assert.throws(() => M.switchVersion(ws, 'nope'), /Unknown version/);
    assert.throws(() => M.renameVersion(ws, 'nope', 'x'), /Unknown version/);
    M.switchVersion(ws, v2);
  });
  test('deleteVersion adds a tombstone, refuses the last one, activates the newest remaining', () => {
    const ws = M.createWorkspace();
    const v1 = ws.versions[0].id;
    const v2 = M.addVersion(ws, { fromVersionId: null });
    const v3 = M.addVersion(ws, { fromVersionId: null });
    M.deleteVersion(ws, v3);
    assert.equal(ws.activeVersionId, v2, 'active deleted → greatest createdAt remaining');
    assert.equal(typeof ws.tombstones[v3], 'string');
    assert.equal(ws.tombstones[v3], ws.updatedAt);
    M.switchVersion(ws, v1);
    M.deleteVersion(ws, v2);
    assert.equal(ws.activeVersionId, v1, 'deleting a non-active version keeps the active one');
    assert.throws(() => M.deleteVersion(ws, v1), /Cannot delete the only version/);
    assert.throws(() => M.deleteVersion(ws, 'nope'), /Unknown version/);
  });
});

describe('updateSettings', () => {
  test('accepts finite numbers without clamping, validates theme/colWidth, rejects non-numbers', () => {
    const ws = M.createWorkspace();
    M.updateSettings(ws, { wpm: 1, pauseSec: 99, targetSec: 1e6, theme: 'dark', colWidth: 420 });
    assert.deepEqual(ws.settings, { wpm: 1, pauseSec: 99, targetSec: 1e6, theme: 'dark', colWidth: 420 });
    assert.throws(() => M.updateSettings(ws, { wpm: '140' }));
    assert.throws(() => M.updateSettings(ws, { wpm: NaN }));
    assert.throws(() => M.updateSettings(ws, { pauseSec: Infinity }));
    assert.throws(() => M.updateSettings(ws, { theme: 'sepia' }));
    assert.throws(() => M.updateSettings(ws, { colWidth: 400 }));
    assert.equal(ws.settings.wpm, 1, 'a rejected patch changes nothing');
  });
});

describe('normalize', () => {
  test('throws for non-object input only', () => {
    assert.throws(() => M.normalize(null));
    assert.throws(() => M.normalize('x'));
    assert.throws(() => M.normalize([]));
    assert.doesNotThrow(() => M.normalize({}));
  });
  test('empty object becomes a valid workspace with one version', () => {
    const ws = M.normalize({});
    assert.equal(ws.schemaVersion, 1);
    assert.equal(typeof ws.id, 'string');
    assert.deepEqual(ws.settings, { wpm: 140, pauseSec: 2, targetSec: 300, theme: 'system', colWidth: 360 });
    assert.equal(ws.settingsUpdatedAt, EPOCH);
    assert.equal(ws.updatedAt, EPOCH);
    assert.deepEqual(ws.tombstones, {});
    assert.equal(ws.versions.length, 1);
    assert.equal(ws.versions[0].name, 'Set v1');
    assert.equal(ws.activeVersionId, ws.versions[0].id);
  });
  test('is idempotent on a normalized workspace and on garbage', () => {
    const garbage = {
      id: 5,
      settings: { wpm: 'abc', pauseSec: 1000, targetSec: -4, theme: 'blue', colWidth: 999 },
      tombstones: { a: '2024-01-01T00:00:00.000Z', b: 5, c: null },
      versions: [
        'nope',
        { id: 'v1', name: 7, topics: 'x', set: null, createdAt: 'garbage' },
        { id: 'v1', name: 'later', updatedAt: '2024-05-05T00:00:00.000Z', topics: [{ id: 't', jokes: [{ id: 'j', text: 1, alts: [{ id: 'x' }, 'bad'] }] }] },
        { id: 'v2', topics: [{ id: 't', jokes: [{ id: 'j', alts: [{ id: 'x' }] }, { id: 'j2', activeAltId: 'zzz', overrideSec: -3 }] }] },
      ],
      activeVersionId: 'missing',
    };
    const once = M.normalize(structuredClone(garbage));
    const twice = M.normalize(structuredClone(once));
    assert.equal(M.stableJson(twice), M.stableJson(once));
    assert.equal(M.stableJson(M.normalize(structuredClone(once))), M.stableJson(once));
  });
  test('settings: NaN/invalid values fall back, numbers are clamped and coerced', () => {
    const ws = M.normalize({ settings: { wpm: NaN, pauseSec: '50', targetSec: '120', theme: 'blue', colWidth: '320' } });
    assert.deepEqual(ws.settings, { wpm: 140, pauseSec: 30, targetSec: 120, theme: 'system', colWidth: 320 });
    const low = M.normalize({ settings: { wpm: 10, pauseSec: -1, targetSec: 0, theme: 'dark', colWidth: 500 } });
    assert.deepEqual(low.settings, { wpm: 60, pauseSec: 0, targetSec: 1, theme: 'dark', colWidth: 360 });
    assert.deepEqual(M.normalize({ settings: 'bad' }).settings.wpm, 140);
  });
  test('invalid timestamps become the epoch; valid ones are kept', () => {
    const ws = M.normalize({
      updatedAt: 'not a date',
      settingsUpdatedAt: 12345,
      versions: [{ id: 'v', createdAt: '2024-02-02T00:00:00.000Z', updatedAt: null, set: { updatedAt: '2024-03-03T00:00:00.000Z' } }],
    });
    assert.equal(ws.updatedAt, EPOCH);
    assert.equal(ws.settingsUpdatedAt, EPOCH);
    assert.equal(ws.versions[0].createdAt, '2024-02-02T00:00:00.000Z');
    assert.equal(ws.versions[0].updatedAt, EPOCH);
    assert.equal(ws.versions[0].set.updatedAt, '2024-03-03T00:00:00.000Z');
  });
  test('tombstones keep only string values', () => {
    assert.deepEqual(M.normalize({ tombstones: { a: '2024', b: 1, c: null, d: {} } }).tombstones, { a: '2024' });
    assert.deepEqual(M.normalize({ tombstones: [] }).tombstones, {});
    assert.deepEqual(M.normalize({ tombstones: 'x' }).tombstones, {});
  });
  test('versions: non-objects dropped, duplicate ids keep the later updatedAt, sorted by (createdAt, id)', () => {
    const ws = M.normalize({
      versions: [
        null,
        { id: 'b', name: 'old', createdAt: '2024-01-02T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' },
        { id: 'a', name: 'A', createdAt: '2024-01-02T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
        { id: 'b', name: 'new', createdAt: '2024-01-02T00:00:00.000Z', updatedAt: '2024-01-03T00:00:00.000Z' },
        { id: 'c', name: 'C', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
      ],
    });
    assert.deepEqual(ws.versions.map((v) => v.id), ['c', 'a', 'b']);
    assert.equal(ws.versions[2].name, 'new');
    assert.equal(ws.activeVersionId, 'c');
  });
  test('empty versions array gets a fresh "Set v1"; versions without an id get one', () => {
    const ws = M.normalize({ versions: [] });
    assert.equal(ws.versions.length, 1);
    assert.equal(ws.versions[0].name, 'Set v1');
    const ws2 = M.normalize({ versions: [{ name: 'x' }] });
    assert.equal(typeof ws2.versions[0].id, 'string');
    assert.equal(ws2.versions[0].name, 'x');
  });
  test('per version: name, topics, set defaults; set ids deduplicated and filtered to this version', () => {
    const ws = M.normalize({
      versions: [
        { id: 'v1', topics: [{ id: 't', jokes: [{ id: 'j1' }, { id: 'j2' }] }], set: { jokeIds: ['j2', 'j1', 'j2', 'other', 'j1'] } },
        { id: 'v2', topics: [{ id: 't2', jokes: [{ id: 'other' }] }], set: { jokeIds: ['j1', 'other'] } },
      ],
    });
    assert.equal(ws.versions[0].name, 'Untitled');
    assert.deepEqual(ws.versions[0].set.jokeIds, ['j2', 'j1']);
    assert.deepEqual(ws.versions[1].set.jokeIds, ['other']);
    const bare = M.normalize({ versions: [{ id: 'v', name: null, topics: null, set: 'x' }] }).versions[0];
    assert.equal(bare.name, 'Untitled');
    assert.deepEqual(bare.topics, []);
    assert.deepEqual(bare.set, { jokeIds: [], updatedAt: EPOCH });
  });
  test('per topic/joke/alt: strings coerced, stray collapsed deleted, invalid override/activeAltId reset', () => {
    const ws = M.normalize({
      versions: [{
        id: 'v',
        topics: [
          7,
          {
            id: 't', title: 5, color: 3, collapsed: true,
            jokes: [
              null,
              { id: 'j1', title: null, text: undefined, notes: 9, alts: [{ id: 'a1', text: 4 }, 'junk'], activeAltId: 'a1', overrideSec: 12 },
              { id: 'j2', alts: 'bad', activeAltId: 'a1', overrideSec: -1 },
              { id: 'j3', overrideSec: 'NaN' },
              { id: 'j4', overrideSec: 0 },
            ],
          },
        ],
      }],
    });
    const topic = ws.versions[0].topics[0];
    assert.equal(ws.versions[0].topics.length, 1);
    assert.equal(topic.title, '5');
    assert.equal(topic.color, null);
    assert.equal('collapsed' in topic, false);
    const [j1, j2, j3, j4] = topic.jokes;
    assert.deepEqual(j1, { id: 'j1', title: '', text: '', alts: [{ id: 'a1', text: '4' }], activeAltId: 'a1', overrideSec: 12, notes: '9' });
    assert.deepEqual(j2.alts, []);
    assert.equal(j2.activeAltId, null, 'activeAltId must be one of its own alts');
    assert.equal(j2.overrideSec, null);
    assert.equal(j3.overrideSec, null);
    assert.equal(j4.overrideSec, 0);
    assert.equal(topic.jokes.length, 4);
  });
  test('duplicate topic/joke/alt ids anywhere get a fresh id on the second occurrence', () => {
    const ws = M.normalize({
      versions: [
        {
          id: 'v1', createdAt: '2024-01-01T00:00:00.000Z',
          topics: [
            { id: 't', jokes: [{ id: 'j', alts: [{ id: 'a' }, { id: 'a' }] }, { id: 'j' }] },
            { id: 't', jokes: [] },
          ],
          set: { jokeIds: ['j'] },
        },
        { id: 'v2', createdAt: '2024-01-02T00:00:00.000Z', topics: [{ id: 't', jokes: [{ id: 'j', alts: [{ id: 'a' }] }] }] },
      ],
    });
    const ids = [];
    for (const v of ws.versions) for (const t of v.topics) {
      ids.push(t.id);
      for (const j of t.jokes) { ids.push(j.id); for (const a of j.alts) ids.push(a.id); }
    }
    assert.equal(new Set(ids).size, ids.length, 'all entity ids unique');
    const [v1, v2] = ws.versions;
    assert.equal(v1.topics[0].id, 't', 'first occurrence keeps its id');
    assert.equal(v1.topics[0].jokes[0].id, 'j');
    assert.equal(v1.topics[0].jokes[0].alts[0].id, 'a');
    assert.notEqual(v1.topics[0].jokes[0].alts[1].id, 'a');
    assert.notEqual(v1.topics[0].jokes[1].id, 'j');
    assert.notEqual(v1.topics[1].id, 't');
    assert.notEqual(v2.topics[0].id, 't');
    assert.deepEqual(v1.set.jokeIds, ['j']);
    assert.deepEqual(v2.set.jokeIds, []);
  });
  test('invalid activeVersionId falls back to the first version', () => {
    const ws = M.normalize({ versions: [{ id: 'v1', createdAt: '2024-01-02T00:00:00.000Z' }, { id: 'v0', createdAt: '2024-01-01T00:00:00.000Z' }], activeVersionId: 'x' });
    assert.equal(ws.activeVersionId, 'v0');
    const keep = M.normalize({ versions: [{ id: 'v1' }, { id: 'v2' }], activeVersionId: 'v2' });
    assert.equal(keep.activeVersionId, 'v2');
  });
  test('a workspace produced by mutations survives normalize unchanged', () => {
    const { ws, a, altA } = fixture();
    M.addToSet(ws, a);
    M.setActiveAlt(ws, a, altA);
    M.addVersion(ws);
    const before = M.stableJson(ws);
    assert.equal(M.stableJson(M.normalize(structuredClone(ws))), before);
  });
});
