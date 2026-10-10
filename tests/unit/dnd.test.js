// Unit tests for the pure geometry helper of js/ui/dnd.js. The controller itself needs a real
// DOM (pointer events, elementFromPoint) and is covered by the Playwright drag specs; here the
// elements are tiny fakes exposing only `children`, `hasAttribute` and `getBoundingClientRect`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInsertIndex, edgeStep, DROP_BY_KIND } from '../../js/ui/dnd.js';

/** A fake card occupying the given box (DOMRect-like). `isCard` false models a non-card child. */
function box({ left = 0, top = 0, width = 100, height = 50, isCard = true } = {}) {
  return {
    hasAttribute: (name) => isCard && name === 'data-card',
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
  };
}

/** A fake container whose direct children are the given fakes. */
function container(children) {
  return { children, hasAttribute: () => false, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 600, right: 300, bottom: 600 }) };
}

// Three vertical cards: 0–50, 60–110, 120–170 (midpoints 25, 85, 145).
const vertical = () => [box({ top: 0 }), box({ top: 60 }), box({ top: 120 })];

test('vertical list: index counts the cards whose midpoint is above the pointer', () => {
  const c = container(vertical());
  assert.equal(computeInsertIndex(c, 10, -20), 0);
  assert.equal(computeInsertIndex(c, 10, 24), 0);
  assert.equal(computeInsertIndex(c, 10, 26), 1);
  assert.equal(computeInsertIndex(c, 10, 84), 1);
  assert.equal(computeInsertIndex(c, 10, 86), 2);
  assert.equal(computeInsertIndex(c, 10, 144), 2);
  assert.equal(computeInsertIndex(c, 10, 146), 3);
  assert.equal(computeInsertIndex(c, 10, 999), 3);
});

test('a pointer exactly on a midpoint inserts before that card', () => {
  const c = container(vertical());
  assert.equal(computeInsertIndex(c, 10, 25), 0);
  assert.equal(computeInsertIndex(c, 10, 85), 1);
});

test('the dragged card is excluded, so the index is relative to the list without it', () => {
  const cards = vertical();
  const c = container(cards);
  // Dragging the middle card: only cards 0 and 2 count.
  assert.equal(computeInsertIndex(c, 10, 86, { excludeEl: cards[1] }), 1);
  assert.equal(computeInsertIndex(c, 10, 146, { excludeEl: cards[1] }), 2);
  // Dragging the first card over its own original slot.
  assert.equal(computeInsertIndex(c, 10, 10, { excludeEl: cards[0] }), 0);
  assert.equal(computeInsertIndex(c, 10, 200, { excludeEl: cards[0] }), 2);
});

test('children without data-card (buttons, indicators, wrappers) are ignored', () => {
  const c = container([box({ top: 0 }), box({ top: 60, isCard: false }), box({ top: 120 })]);
  assert.equal(computeInsertIndex(c, 10, 86), 1);
  assert.equal(computeInsertIndex(c, 10, 146), 2);
  assert.equal(computeInsertIndex(c, 10, 999), 2);
});

test('empty container (or only the dragged card) → 0', () => {
  assert.equal(computeInsertIndex(container([]), 50, 50), 0);
  const only = box();
  assert.equal(computeInsertIndex(container([only]), 50, 500, { excludeEl: only }), 0);
});

test('horizontal (topic columns) compares x against horizontal midpoints and ignores y', () => {
  // Columns at 0–100, 120–220, 240–340 (midpoints 50, 170, 290).
  const cols = [box({ left: 0, width: 100 }), box({ left: 120, width: 100 }), box({ left: 240, width: 100 })];
  const c = container(cols);
  assert.equal(computeInsertIndex(c, 10, 5000, { horizontal: true }), 0);
  assert.equal(computeInsertIndex(c, 51, 0, { horizontal: true }), 1);
  assert.equal(computeInsertIndex(c, 171, 0, { horizontal: true }), 2);
  assert.equal(computeInsertIndex(c, 291, 0, { horizontal: true }), 3);
  assert.equal(computeInsertIndex(c, 171, 0, { horizontal: true, excludeEl: cols[0] }), 1);
  // Vertical mode on the same row of columns would never advance (all midpoints share y=25).
  assert.equal(computeInsertIndex(c, 291, 0), 0);
});

test('DROP_BY_KIND maps each drag kind to its container attribute', () => {
  assert.deepEqual(DROP_BY_KIND, { topic: 'topics', joke: 'jokes', alt: 'alts', set: 'set' });
});

test('edgeStep scrolls only near an edge and never for a pointer well outside the box', () => {
  // Box [100, 500], 40 px edge zones, up to 14 px per frame.
  assert.equal(edgeStep(300, 100, 500), 0); // middle
  assert.equal(edgeStep(100, 100, 500), -14); // on the top edge: full speed up
  assert.equal(edgeStep(120, 100, 500), -7);
  assert.equal(edgeStep(500, 100, 500), 14); // on the bottom edge: full speed down
  assert.equal(edgeStep(480, 100, 500), 7);
  assert.equal(edgeStep(80, 100, 500), -14); // just outside still counts as the edge
  assert.equal(edgeStep(520, 100, 500), 14);
  assert.equal(edgeStep(0, 100, 500), 0); // far outside (over another panel): nothing
  assert.equal(edgeStep(900, 100, 500), 0);
});
