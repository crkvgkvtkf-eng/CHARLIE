// Pointer-based drag & drop controller (SPEC §9.4). Framework-free: the UI attaches grip
// elements, the controller reports drops as { kind, id, containerId, index } and never touches
// application state itself.
//
// Gesture model
//   pointerdown on a grip (primary button) → "pending". Mouse/pen: the drag starts after 4 px of
//   movement; touch: after a 150 ms hold (a pointerup/pointercancel before that is a tap and is
//   ignored). Pointer capture is attempted but never relied upon: pointermove/pointerup/pointercancel
//   are also listened for on `window`, so synthetic PointerEvents dispatched on `document` (as the
//   iPhone e2e tests do) drive the controller exactly like real input.
//
// While dragging
//   - `document.body.is-dragging`, source card `.is-dragging`, and the board (`[data-drop="topics"]`)
//     `.is-dragging-board` (the mobile stylesheet uses it to turn scroll snapping off).
//   - A `position: fixed; pointer-events: none` ghost (`.dnd-ghost`) shows only the card's header row:
//     the element marked `[data-card-header]` (the card itself when the whole card is the header, as a
//     set row is, else one inside it), else the card's first element child, else the card itself. Clone
//     ids/test ids are stripped so queries never see duplicates.
//   - The drop target is `document.elementFromPoint(x, y)` → closest `[data-drop="<kind's container>"]`.
//     The insertion index compares the pointer to the midpoints of the container's direct children
//     that carry `[data-card]`, excluding the dragged card (vertical for lists, horizontal for topics),
//     so it is already "the index after the moved item was removed", as the model expects.
//   - The insertion indicator is a single fixed-position element (`.dnd-indicator`, appended to
//     `document.body`) laid over the gap where the card would land. Fixed positioning was chosen over
//     an absolutely positioned child because containers clip overflow and scroll independently; the
//     indicator is re-laid-out on every move and on every auto-scroll frame, so it never drifts.
//   - Auto-scroll: the nearest vertically scrollable ancestor of the element under the pointer scrolls
//     while the pointer is within 40 px of its top/bottom edge. The board scrolls horizontally the same
//     way only when it carries `data-dnd-hscroll="1"` (the desktop layout sets it).
//   - Paging (mobile): when the board carries `data-dnd-page="1"`, holding the pointer within 40 px of
//     the board's left/right edge for 500 ms calls `onPage('left'|'right')` once per dwell (the pointer
//     must leave the edge zone before another page can fire). A zone the pointer is already in when the
//     drag starts is never armed: joke grips sit inside the left zone, so merely holding a grip must not
//     page the board and drop the card into the neighbouring topic.
//   - `pointercancel`, Escape, window `blur` and `visibilitychange→hidden` cancel the drag without a drop.

/** Drag kind → value of the `data-drop` attribute on the container that accepts it. */
export const DROP_BY_KIND = Object.freeze({ topic: 'topics', joke: 'jokes', alt: 'alts', set: 'set' });

const MOUSE_START_PX = 4;
const TOUCH_HOLD_MS = 150;
const EDGE_PX = 40;
const PAGE_DWELL_MS = 500;
const MAX_SCROLL_PX_PER_FRAME = 14;
const GHOST_MAX_HEIGHT_PX = 72;

/** Direct children of `containerEl` carrying `data-card`, minus `excludeEl` (the dragged card). */
function cardsOf(containerEl, excludeEl) {
  return Array.from(containerEl.children).filter((el) => el !== excludeEl && el.hasAttribute('data-card'));
}

/**
 * Insertion index for a pointer at (x, y) over `containerEl`: the number of cards whose midpoint
 * lies before the pointer. Only needs `children`, `hasAttribute` and `getBoundingClientRect` on the
 * elements, so it is unit-tested with plain fakes.
 */
export function computeInsertIndex(containerEl, x, y, { horizontal = false, excludeEl = null } = {}) {
  let index = 0;
  for (const card of cardsOf(containerEl, excludeEl)) {
    const r = card.getBoundingClientRect();
    const mid = horizontal ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2;
    if ((horizontal ? x : y) > mid) index++;
  }
  return index;
}

/** Id of the entity a drop container belongs to (topic for jokes, joke for alts, none otherwise). */
function containerIdOf(containerEl, kind) {
  if (kind === 'joke') return containerEl.getAttribute('data-topic-id');
  if (kind === 'alt') return containerEl.getAttribute('data-joke-id');
  return null;
}

/** Nearest ancestor-or-self that actually scrolls along `axis` ('x' | 'y'); null when none. */
function findScroller(el, axis) {
  const doc = el && el.ownerDocument;
  const win = doc && doc.defaultView;
  for (let node = el; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    const overflow = axis === 'y' ? style.overflowY : style.overflowX;
    const canScroll = axis === 'y' ? node.scrollHeight > node.clientHeight : node.scrollWidth > node.clientWidth;
    if ((overflow === 'auto' || overflow === 'scroll') && canScroll) return node;
  }
  return null;
}

/** Signed scroll step for a pointer coordinate `p` inside [lo, hi]: negative near `lo`, positive near `hi`. */
function edgeStep(p, lo, hi) {
  if (p - lo < EDGE_PX) return -Math.ceil(((EDGE_PX - Math.max(0, p - lo)) / EDGE_PX) * MAX_SCROLL_PX_PER_FRAME);
  if (hi - p < EDGE_PX) return Math.ceil(((EDGE_PX - Math.max(0, hi - p)) / EDGE_PX) * MAX_SCROLL_PX_PER_FRAME);
  return 0;
}

/** The header row of a card: the card itself when it is marked as one (set rows), else the marked descendant. */
function headerOf(cardEl) {
  if (cardEl.matches('[data-card-header]')) return cardEl;
  return cardEl.querySelector('[data-card-header]') || cardEl.firstElementChild || cardEl;
}

/** Builds the fixed ghost element from the card's header row. */
function makeGhost(cardEl, doc) {
  const source = headerOf(cardEl);
  const clone = source.cloneNode(true);
  // Form controls carry their text in the `value` property, which cloneNode does not copy.
  const sourceFields = source.querySelectorAll('input, textarea');
  clone.querySelectorAll('input, textarea').forEach((field, i) => {
    if (sourceFields[i]) field.value = sourceFields[i].value;
  });
  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    el.removeAttribute('id');
    el.removeAttribute('data-testid');
    el.removeAttribute('autofocus');
  }
  const ghost = doc.createElement('div');
  ghost.className = 'dnd-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  const width = cardEl.getBoundingClientRect().width;
  Object.assign(ghost.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: `${width}px`,
    maxHeight: `${GHOST_MAX_HEIGHT_PX}px`,
    overflow: 'hidden',
    opacity: '0.85',
    pointerEvents: 'none',
    zIndex: '1000',
    boxSizing: 'border-box',
    willChange: 'transform',
  });
  ghost.appendChild(clone);
  return ghost;
}

/** Builds the (initially hidden) insertion indicator. Colour comes from the stylesheet via --accent. */
function makeIndicator(doc) {
  const el = doc.createElement('div');
  el.className = 'dnd-indicator';
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '999',
    borderRadius: '2px',
    background: 'var(--accent, #3b82f6)',
    display: 'none',
  });
  return el;
}

/** Places the indicator over the gap at `index` inside `containerEl`. */
function layoutIndicator(indicator, containerEl, index, { horizontal, excludeEl }) {
  const cards = cardsOf(containerEl, excludeEl);
  const box = containerEl.getBoundingClientRect();
  const thickness = 3;
  let pos; // the coordinate of the gap along the drag axis
  if (cards.length === 0) {
    pos = horizontal ? box.left + 4 : box.top + 4;
  } else if (index <= 0) {
    const r = cards[0].getBoundingClientRect();
    pos = (horizontal ? r.left : r.top) - 3;
  } else if (index >= cards.length) {
    const r = cards[cards.length - 1].getBoundingClientRect();
    pos = (horizontal ? r.right : r.bottom) + 3;
  } else {
    const a = cards[index - 1].getBoundingClientRect();
    const b = cards[index].getBoundingClientRect();
    pos = horizontal ? (a.right + b.left) / 2 : (a.bottom + b.top) / 2;
  }
  indicator.setAttribute('data-orientation', horizontal ? 'vertical' : 'horizontal');
  if (horizontal) {
    Object.assign(indicator.style, {
      left: `${pos - thickness / 2}px`, top: `${box.top}px`, width: `${thickness}px`, height: `${box.height}px`,
    });
  } else {
    Object.assign(indicator.style, {
      left: `${box.left}px`, top: `${pos - thickness / 2}px`, width: `${box.width}px`, height: `${thickness}px`,
    });
  }
  indicator.style.display = 'block';
}

/**
 * @param {object} options
 * @param {(drop: { kind: string, id: string, containerId: string|null, index: number }) => void} options.onDrop
 * @param {(state: { dragging: boolean, kind: string }) => void} [options.onStateChange]
 * @param {(direction: 'left'|'right') => void} [options.onPage]  mobile edge-dwell paging
 */
export function createDnd({ onDrop, onStateChange = () => {}, onPage = () => {} }) {
  /** @type {Map<Element, { kind: string, id: string, cardEl: Element|null, listeners: [string, Function][] }>} */
  const grips = new Map();
  /** The current gesture (pending or dragging); null when idle. */
  let gesture = null;

  function attach(gripEl, { kind, id, cardEl = null }) {
    if (grips.has(gripEl)) detach(gripEl);
    const onDown = (e) => onPointerDown(e, gripEl);
    const prevent = (e) => e.preventDefault();
    const listeners = [['pointerdown', onDown], ['contextmenu', prevent], ['dragstart', prevent]];
    for (const [type, fn] of listeners) gripEl.addEventListener(type, fn);
    grips.set(gripEl, { kind, id, cardEl, listeners });
  }

  function detach(gripEl) {
    const entry = grips.get(gripEl);
    if (!entry) return;
    for (const [type, fn] of entry.listeners) gripEl.removeEventListener(type, fn);
    grips.delete(gripEl);
    if (gesture && gesture.grip === gripEl) endGesture(false);
  }

  function destroy() {
    endGesture(false);
    for (const gripEl of Array.from(grips.keys())) detach(gripEl);
  }

  function onPointerDown(e, gripEl) {
    if (gesture) return;
    if (e.isPrimary === false || (e.button != null && e.button !== 0)) return;
    const entry = grips.get(gripEl);
    const cardEl = entry.cardEl || gripEl.closest('[data-card]');
    if (!cardEl) return;
    e.preventDefault();
    const doc = gripEl.ownerDocument;
    const win = doc.defaultView;
    gesture = {
      grip: gripEl,
      kind: entry.kind,
      id: entry.id,
      cardEl,
      doc,
      win,
      pointerId: e.pointerId,
      isTouch: e.pointerType === 'touch',
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      dragging: false,
      holdTimer: null,
      raf: 0,
      ghost: null,
      ghostOffsetX: 0,
      ghostOffsetY: 0,
      indicator: null,
      board: null,
      target: null, // { containerEl, containerId, index }
      dwellZone: null,
      dwellTimer: null,
      windowListeners: [],
    };
    try { gripEl.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }

    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      gesture.windowListeners.push([target, type, fn, opts]);
    };
    on(win, 'pointermove', onPointerMove);
    on(win, 'pointerup', onPointerUp);
    on(win, 'pointercancel', cancel);
    on(win, 'keydown', onKeyDown, true);
    on(win, 'blur', cancel);
    on(doc, 'visibilitychange', onVisibilityChange);

    if (gesture.isTouch) gesture.holdTimer = setTimeout(startDrag, TOUCH_HOLD_MS);
  }

  function samePointer(e) {
    return gesture.pointerId == null || e.pointerId == null || e.pointerId === gesture.pointerId;
  }

  function onPointerMove(e) {
    if (!gesture || !samePointer(e)) return;
    gesture.x = e.clientX;
    gesture.y = e.clientY;
    if (!gesture.dragging) {
      if (gesture.isTouch) return; // waiting for the hold timer; finger jitter is fine
      if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) >= MOUSE_START_PX) startDrag();
      return;
    }
    e.preventDefault();
    moveGhost();
    updateTarget();
    updateDwell();
  }

  function onPointerUp(e) {
    if (!gesture || !samePointer(e)) return;
    endGesture(gesture.dragging);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') cancel();
  }

  function onVisibilityChange() {
    if (gesture && gesture.doc.visibilityState === 'hidden') cancel();
  }

  function cancel() {
    if (gesture) endGesture(false);
  }

  function startDrag() {
    const g = gesture;
    if (!g || g.dragging) return;
    clearTimeout(g.holdTimer);
    g.holdTimer = null;
    g.dragging = true;
    const { doc } = g;
    const cardRect = g.cardEl.getBoundingClientRect();
    g.ghost = makeGhost(g.cardEl, doc);
    g.ghostOffsetX = Math.max(0, Math.min(g.startX - cardRect.left, cardRect.width - 8));
    g.ghostOffsetY = Math.max(0, Math.min(g.startY - cardRect.top, GHOST_MAX_HEIGHT_PX - 8));
    g.indicator = makeIndicator(doc);
    doc.body.appendChild(g.ghost);
    doc.body.appendChild(g.indicator);
    doc.body.classList.add('is-dragging');
    g.cardEl.classList.add('is-dragging');
    g.board = doc.querySelector('[data-drop="topics"]');
    if (g.board) g.board.classList.add('is-dragging-board');
    moveGhost();
    updateTarget();
    // Seed, do not arm: the zone under the pointer at the start of the drag only becomes
    // pageable after the pointer has left it once (see the header comment on paging).
    g.dwellZone = dwellZoneAt(g);
    onStateChange({ dragging: true, kind: g.kind });
    if (typeof g.win.requestAnimationFrame === 'function') g.raf = g.win.requestAnimationFrame(frame);
  }

  function moveGhost() {
    const g = gesture;
    g.ghost.style.transform = `translate(${g.x - g.ghostOffsetX}px, ${g.y - g.ghostOffsetY}px)`;
  }

  /** Recomputes the drop target from the element under the pointer and re-lays the indicator. */
  function updateTarget() {
    const g = gesture;
    const hit = g.doc.elementFromPoint(g.x, g.y);
    const containerEl = hit && hit.closest(`[data-drop="${DROP_BY_KIND[g.kind]}"]`);
    if (!containerEl) {
      g.target = null;
      g.indicator.style.display = 'none';
      return;
    }
    const geometry = { horizontal: g.kind === 'topic', excludeEl: g.cardEl };
    const index = computeInsertIndex(containerEl, g.x, g.y, geometry);
    g.target = { containerEl, containerId: containerIdOf(containerEl, g.kind), index };
    layoutIndicator(g.indicator, containerEl, index, geometry);
  }

  /** The paging edge zone ('left' | 'right' | null) the pointer is in, when the board pages at all. */
  function dwellZoneAt(g) {
    if (!g.board || g.board.getAttribute('data-dnd-page') !== '1') return null;
    const r = g.board.getBoundingClientRect();
    if (g.x <= r.left + EDGE_PX) return 'left';
    if (g.x >= r.right - EDGE_PX) return 'right';
    return null;
  }

  /** Edge-dwell paging on the mobile board: one onPage() per uninterrupted stay in an edge zone. */
  function updateDwell() {
    const g = gesture;
    const zone = dwellZoneAt(g);
    if (zone === g.dwellZone) return;
    clearTimeout(g.dwellTimer);
    g.dwellTimer = null;
    g.dwellZone = zone;
    if (zone) {
      g.dwellTimer = setTimeout(() => {
        g.dwellTimer = null;
        onPage(zone);
        if (gesture === g) updateTarget(); // a different column is now under the still pointer
      }, PAGE_DWELL_MS);
    }
  }

  /** Per-frame auto-scroll while dragging; the target is recomputed only when something scrolled. */
  function frame() {
    const g = gesture;
    if (!g || !g.dragging) return;
    let scrolled = false;
    const hit = g.doc.elementFromPoint(g.x, g.y);
    const vScroller = hit && findScroller(hit, 'y');
    if (vScroller) {
      const r = vScroller.getBoundingClientRect();
      const step = edgeStep(g.y, r.top, r.bottom);
      if (step) {
        const before = vScroller.scrollTop;
        vScroller.scrollTop += step;
        scrolled = vScroller.scrollTop !== before;
      }
    }
    if (g.board && g.board.getAttribute('data-dnd-hscroll') === '1') {
      const r = g.board.getBoundingClientRect();
      const step = edgeStep(g.x, r.left, r.right);
      if (step) {
        const before = g.board.scrollLeft;
        g.board.scrollLeft += step;
        scrolled = scrolled || g.board.scrollLeft !== before;
      }
    }
    if (scrolled) updateTarget();
    g.raf = g.win.requestAnimationFrame(frame);
  }

  /** Ends the gesture; `drop` true delivers the current target (if any) to onDrop. */
  function endGesture(drop) {
    const g = gesture;
    if (!g) return;
    gesture = null;
    clearTimeout(g.holdTimer);
    clearTimeout(g.dwellTimer);
    if (g.raf && typeof g.win.cancelAnimationFrame === 'function') g.win.cancelAnimationFrame(g.raf);
    for (const [target, type, fn, opts] of g.windowListeners) target.removeEventListener(type, fn, opts);
    try { g.grip.releasePointerCapture(g.pointerId); } catch { /* no capture held */ }
    if (!g.dragging) return;
    if (g.ghost) g.ghost.remove();
    if (g.indicator) g.indicator.remove();
    g.doc.body.classList.remove('is-dragging');
    g.cardEl.classList.remove('is-dragging');
    if (g.board) g.board.classList.remove('is-dragging-board');
    if (drop && g.target) {
      onDrop({ kind: g.kind, id: g.id, containerId: g.target.containerId, index: g.target.index });
    }
    onStateChange({ dragging: false, kind: g.kind });
  }

  return { attach, detach, destroy };
}
