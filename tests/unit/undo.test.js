// Unit tests for js/undo.js (SPEC §5, §13 "undo" bullets). The clock is injected so the
// coalescing idle window is exercised deterministically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../../js/undo.js';

/** A controllable millisecond clock: `tick(ms)` advances it, `now` reads it. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

test('empty history: nothing to undo or redo, undo/redo return null', () => {
  const h = createHistory({ now: () => 0 });
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.undo('s'), null);
  assert.equal(h.redo('s'), null);
});

test('push then undo returns the "before" state and makes the current state redoable', () => {
  const h = createHistory({ now: () => 0 });
  h.push('a');
  assert.equal(h.canUndo(), true);
  assert.equal(h.undo('b'), 'a');
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), true);
  assert.equal(h.redo('a'), 'b');
  assert.equal(h.canRedo(), false);
  assert.equal(h.canUndo(), true);
});

test('coalescing: same key 500 ms apart → one entry; 1500 ms apart → two', () => {
  const clock = fakeClock();
  const h = createHistory({ now: clock.now, coalesceMs: 1000 });
  h.push('', { coalesceKey: 'joke:text:1' });
  clock.tick(500);
  h.push('h', { coalesceKey: 'joke:text:1' });
  clock.tick(500);
  h.push('he', { coalesceKey: 'joke:text:1' });
  // Three keystrokes within the idle window: one undo restores the initial state.
  assert.equal(h.undo('hel'), '');
  assert.equal(h.canUndo(), false);

  const h2 = createHistory({ now: clock.now, coalesceMs: 1000 });
  h2.push('', { coalesceKey: 'joke:text:1' });
  clock.tick(1500);
  h2.push('h', { coalesceKey: 'joke:text:1' });
  assert.equal(h2.undo('he'), 'h');
  assert.equal(h2.undo('h'), '');
  assert.equal(h2.canUndo(), false);
});

test('coalescing refreshes the entry timestamp so a continuous run keeps merging', () => {
  const clock = fakeClock();
  const h = createHistory({ now: clock.now, coalesceMs: 1000 });
  h.push('', { coalesceKey: 'k' });
  for (let i = 0; i < 5; i++) {
    clock.tick(800); // each keystroke is within 1000 ms of the previous one, but far from the first
    h.push('x'.repeat(i + 1), { coalesceKey: 'k' });
  }
  assert.equal(h.undo('xxxxxx'), '');
  assert.equal(h.canUndo(), false);
});

test('different keys and null keys never coalesce', () => {
  const h = createHistory({ now: () => 0 });
  h.push('a', { coalesceKey: 'k1' });
  h.push('b', { coalesceKey: 'k2' });
  h.push('c', { coalesceKey: 'k2' });
  h.push('d');
  h.push('e');
  assert.equal(h.undo('f'), 'e');
  assert.equal(h.undo('e'), 'd');
  assert.equal(h.undo('d'), 'b');
  assert.equal(h.undo('b'), 'a');
  assert.equal(h.canUndo(), false);
});

test('type / undo / type / undo: a restore starts a new coalescing run', () => {
  const clock = fakeClock();
  const h = createHistory({ now: clock.now });
  h.push('', { coalesceKey: 'k' });
  h.push('a', { coalesceKey: 'k' });
  assert.equal(h.undo('ab'), '');
  // Typing again with the same key right away must not merge into anything that was undone.
  h.push('', { coalesceKey: 'k' });
  h.push('c', { coalesceKey: 'k' });
  assert.equal(h.undo('cd'), '');
  assert.equal(h.canUndo(), false);
});

test('redo stack is cleared on push, even on a coalesced push', () => {
  const clock = fakeClock();
  const h = createHistory({ now: clock.now });
  h.push('a', { coalesceKey: 'k' });
  assert.equal(h.undo('b'), 'a');
  assert.equal(h.canRedo(), true);
  h.push('a', { coalesceKey: 'k' }); // new run (the undo closed the old entry)
  assert.equal(h.canRedo(), false);

  h.push('a2', { coalesceKey: 'k' }); // coalesces into the entry pushed above
  assert.equal(h.undo('a3'), 'a');
  assert.equal(h.canRedo(), true);
  // Simulate: a change coalesces into an existing open entry while a redo is available.
  h.push('x', { coalesceKey: 'z' });
  assert.equal(h.canRedo(), false);
  h.push('y', { coalesceKey: 'z' }); // coalesced
  assert.equal(h.canRedo(), false);
});

test('redo pushes the current state as a closed entry (no later coalescing into it)', () => {
  const clock = fakeClock();
  const h = createHistory({ now: clock.now });
  h.push('a', { coalesceKey: 'k' });
  h.undo('b');
  assert.equal(h.redo('a'), 'b');
  h.push('b', { coalesceKey: 'k' }); // must NOT merge into the closed redo entry
  assert.equal(h.undo('c'), 'b');
  assert.equal(h.undo('b'), 'a');
});

test('limit drops the oldest entries', () => {
  const h = createHistory({ limit: 3, now: () => 0 });
  for (const s of ['s0', 's1', 's2', 's3', 's4']) h.push(s);
  assert.equal(h.undo('s5'), 's4');
  assert.equal(h.undo('s4'), 's3');
  assert.equal(h.undo('s3'), 's2');
  assert.equal(h.canUndo(), false);
});

test('breakCoalescing closes the top entry so the next same-key push is separate', () => {
  const clock = fakeClock();
  const h = createHistory({ now: clock.now });
  h.push('', { coalesceKey: 'k' });
  h.push('a', { coalesceKey: 'k' });
  h.breakCoalescing();
  h.push('ab', { coalesceKey: 'k' });
  h.push('abc', { coalesceKey: 'k' }); // merges with 'ab' entry, not with the closed one
  assert.equal(h.undo('abcd'), 'ab');
  assert.equal(h.undo('ab'), '');
  assert.equal(h.canUndo(), false);
  h.breakCoalescing(); // no-op on an empty stack
  assert.equal(h.canUndo(), false);
});

test('clear empties both stacks', () => {
  const h = createHistory({ now: () => 0 });
  h.push('a');
  h.push('b');
  h.undo('c');
  assert.equal(h.canUndo(), true);
  assert.equal(h.canRedo(), true);
  h.clear();
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.undo('x'), null);
  assert.equal(h.redo('x'), null);
});

test('stored states are returned by identity, never copied or mutated', () => {
  const h = createHistory({ now: () => 0 });
  const before = { versions: [{ id: 'v1' }] };
  h.push(before);
  assert.equal(h.undo({ versions: [] }), before);
});

test('undo closes the entry that becomes the top, so typing right after an undo starts a new run', () => {
  const clock = fakeClock();
  const h = createHistory({ now: clock.now, coalesceMs: 1000 });
  h.push('', { coalesceKey: 'text' });
  h.push('a', { coalesceKey: 'text' }); // coalesces: one entry holding ''
  h.push('ab', { coalesceKey: 'title' }); // a different field
  assert.equal(h.undo('ab+title'), 'ab');
  // Still inside the idle window of the 'text' entry: a restore must not let this merge into it.
  h.push('ab', { coalesceKey: 'text' });
  assert.equal(h.undo('abc'), 'ab', 'undo returns the state before the post-undo typing');
  assert.equal(h.undo('ab'), '');
  assert.equal(h.canUndo(), false);
});
