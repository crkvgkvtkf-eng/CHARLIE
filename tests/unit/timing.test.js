// Unit tests for js/timing.js (SPEC §4, §13).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setClock, setIdFactory } from '../../js/ids.js';
import * as M from '../../js/model.js';
import {
  countWords, jokeSeconds, setEstimate, topicEstimate, formatDuration, formatDelta, parseDuration,
} from '../../js/timing.js';

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

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

describe('countWords', () => {
  test('splits on whitespace and counts tokens with a letter or digit', () => {
    assert.equal(countWords('one two three'), 3);
    assert.equal(countWords('  leading and trailing  '), 3);
    assert.equal(countWords('line\nbreaks\tand tabs'), 4);
    assert.equal(countWords("don't"), 1);
    assert.equal(countWords('5'), 1);
    assert.equal(countWords('—'), 0);
    assert.equal(countWords('a — b'), 2);
    assert.equal(countWords('... !!! ---'), 0);
    assert.equal(countWords('café naïve 日本語'), 3);
    assert.equal(countWords(''), 0);
    assert.equal(countWords('   '), 0);
    assert.equal(countWords(null), 0);
    assert.equal(countWords(undefined), 0);
  });
});

describe('jokeSeconds', () => {
  const settings = { wpm: 140, pauseSec: 2 };
  test('words at wpm plus the pause', () => {
    close(jokeSeconds({ text: words(140), alts: [], activeAltId: null, overrideSec: null }, settings), 62);
    close(jokeSeconds({ text: words(70), alts: [], activeAltId: null, overrideSec: null }, { wpm: 70, pauseSec: 0 }), 60);
  });
  test('zero-word joke without override costs only the pause', () => {
    assert.equal(jokeSeconds({ text: '', alts: [], activeAltId: null, overrideSec: null }, settings), 2);
    assert.equal(jokeSeconds({ text: '— …', alts: [], activeAltId: null, overrideSec: null }, settings), 2);
  });
  test('override wins, including zero; negative values never leak', () => {
    assert.equal(jokeSeconds({ text: words(100), alts: [], activeAltId: null, overrideSec: 15 }, settings), 15);
    assert.equal(jokeSeconds({ text: words(100), alts: [], activeAltId: null, overrideSec: 0 }, settings), 0);
    assert.equal(jokeSeconds({ text: words(100), alts: [], activeAltId: null, overrideSec: -3 }, settings), 0);
    assert.equal(jokeSeconds({ text: '', alts: [], activeAltId: null, overrideSec: null }, { wpm: 140, pauseSec: -5 }) >= 0, true);
  });
  test('uses the delivered text (active alt)', () => {
    const joke = { text: words(14), alts: [{ id: 'a', text: words(28) }], activeAltId: 'a', overrideSec: null };
    close(jokeSeconds(joke, settings), 12 + 2);
    joke.activeAltId = null;
    close(jokeSeconds(joke, settings), 6 + 2);
  });
  test('falls back to default pace for unusable settings', () => {
    close(jokeSeconds({ text: words(140), alts: [], activeAltId: null, overrideSec: null }, undefined), 62);
    close(jokeSeconds({ text: words(140), alts: [], activeAltId: null, overrideSec: null }, { wpm: 0, pauseSec: NaN }), 62);
  });
});

describe('setEstimate', () => {
  function fixture() {
    const ws = M.createWorkspace();
    const t1 = M.addTopic(ws, { title: 'Cats' });
    const t2 = M.addTopic(ws, { title: 'Dogs' });
    const a = M.addJoke(ws, t1, { title: 'Opener', text: words(70) }); // 30 + 2
    const b = M.addJoke(ws, t1, { text: '  some   spaced   text  that goes on and on and on until it is well past sixty characters long indeed yes' }); // 20 words
    const c = M.addJoke(ws, t2, { text: words(140) }); // override 10
    const d = M.addJoke(ws, t2, { text: '' }); // not in set
    M.updateJoke(ws, c, { overrideSec: 10 });
    return { ws, t1, t2, a, b, c, d };
  }
  test('empty set', () => {
    const ws = M.createWorkspace();
    assert.deepEqual(setEstimate(ws), { totalSec: 0, words: 0, items: [], targetSec: 300, deltaSec: -300, ratio: 0 });
  });
  test('items follow set order with title/snippet/topic/seconds/words/overridden', () => {
    const { ws, a, b, c } = fixture();
    M.addToSet(ws, c);
    M.addToSet(ws, a);
    M.addToSet(ws, b);
    const est = setEstimate(ws);
    assert.deepEqual(est.items.map((i) => i.jokeId), [c, a, b]);
    const [ic, ia, ib] = est.items;
    assert.equal(ic.seconds, 10);
    assert.equal(ic.overridden, true);
    assert.equal(ic.words, 140);
    assert.equal(ic.topicTitle, 'Dogs');
    assert.equal(ic.title, 'w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w'.slice(0, 60));
    close(ia.seconds, 32);
    assert.equal(ia.overridden, false);
    assert.equal(ia.title, 'Opener');
    assert.equal(ia.topicTitle, 'Cats');
    assert.equal(ib.snippet.length, 60);
    assert.equal(ib.snippet, 'some spaced text that goes on and on and on until it is well');
    assert.equal(ib.title, ib.snippet);
    assert.equal(ib.words, 20);
    close(est.totalSec, 10 + 32 + (20 / 140) * 60 + 2);
    assert.equal(est.words, 140 + 70 + 20);
    assert.equal(est.targetSec, 300);
    close(est.deltaSec, est.totalSec - 300);
    close(est.ratio, est.totalSec / 300);
  });
  test('untitled empty joke gets "Untitled joke"; settings changes change the total', () => {
    const { ws, d } = fixture();
    M.addToSet(ws, d);
    assert.equal(setEstimate(ws).items[0].title, 'Untitled joke');
    assert.equal(setEstimate(ws).items[0].snippet, '');
    assert.equal(setEstimate(ws).totalSec, 2);
    M.updateSettings(ws, { pauseSec: 5, targetSec: 10 });
    const est = setEstimate(ws);
    assert.equal(est.totalSec, 5);
    assert.equal(est.deltaSec, -5);
    assert.equal(est.ratio, 0.5);
  });
  test('estimates the active version only', () => {
    const { ws, a } = fixture();
    M.addToSet(ws, a);
    M.addVersion(ws, { fromVersionId: null });
    assert.equal(setEstimate(ws).items.length, 0);
  });
});

describe('topicEstimate', () => {
  test('counts in-set jokes of the topic and their seconds', () => {
    const ws = M.createWorkspace();
    const t1 = M.addTopic(ws, { title: 'Cats' });
    const t2 = M.addTopic(ws, { title: 'Dogs' });
    const a = M.addJoke(ws, t1, { text: words(70) });
    M.addJoke(ws, t1, { text: words(7) });
    const c = M.addJoke(ws, t2, { text: words(7) });
    M.addToSet(ws, a);
    M.addToSet(ws, c);
    const est = topicEstimate(ws, t1);
    assert.equal(est.inSet, 1);
    assert.equal(est.total, 2);
    close(est.seconds, 32);
    assert.deepEqual(topicEstimate(ws, t2), { inSet: 1, total: 1, seconds: 3 + 2 });
    const empty = M.addTopic(ws);
    assert.deepEqual(topicEstimate(ws, empty), { inSet: 0, total: 0, seconds: 0 });
    assert.throws(() => topicEstimate(ws, 'nope'), /Unknown topic/);
  });
});

describe('formatDuration', () => {
  test('m:ss, rounding to the nearest second', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(5), '0:05');
    assert.equal(formatDuration(59.4), '0:59');
    assert.equal(formatDuration(59.5), '1:00');
    assert.equal(formatDuration(300), '5:00');
    assert.equal(formatDuration(754.2), '12:34');
    assert.equal(formatDuration(3599.4), '59:59');
  });
  test('h:mm:ss from one hour', () => {
    assert.equal(formatDuration(3600), '1:00:00');
    assert.equal(formatDuration(3723), '1:02:03');
    assert.equal(formatDuration(36000), '10:00:00');
  });
  test('tolerates bad input', () => {
    assert.equal(formatDuration(NaN), '0:00');
    assert.equal(formatDuration(undefined), '0:00');
    assert.equal(formatDuration(-12), '0:12');
  });
});

describe('formatDelta', () => {
  test('signed with U+2212 for negatives', () => {
    assert.equal(formatDelta(12), '+0:12');
    assert.equal(formatDelta(-12), '−0:12');
    assert.equal(formatDelta(0), '0:00');
    assert.equal(formatDelta(0.3), '0:00');
    assert.equal(formatDelta(-0.4), '0:00');
    assert.equal(formatDelta(90.6), '+1:31');
    assert.equal(formatDelta(-3723), '−1:02:03');
    assert.equal(formatDelta(NaN), '0:00');
  });
});

describe('parseDuration', () => {
  test('accepts seconds, m:ss and h:mm:ss', () => {
    assert.equal(parseDuration('5:00'), 300);
    assert.equal(parseDuration('90'), 90);
    assert.equal(parseDuration('1:02:03'), 3723);
    assert.equal(parseDuration('0:05'), 5);
    assert.equal(parseDuration('12:7'), 727);
    assert.equal(parseDuration(' 2:30 '), 150);
    assert.equal(parseDuration('0'), 0);
  });
  test('rejects everything else', () => {
    assert.equal(parseDuration(''), null);
    assert.equal(parseDuration('   '), null);
    assert.equal(parseDuration('abc'), null);
    assert.equal(parseDuration('1:60'), null);
    assert.equal(parseDuration('1:2:60'), null);
    assert.equal(parseDuration('1:123'), null);
    assert.equal(parseDuration('-5'), null);
    assert.equal(parseDuration('5:'), null);
    assert.equal(parseDuration(':30'), null);
    assert.equal(parseDuration('1.5'), null);
    assert.equal(parseDuration(null), null);
    assert.equal(parseDuration(90), null);
  });
});
