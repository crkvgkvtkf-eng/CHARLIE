// The Set (SPEC §9.5): the ordered list of jokes in the active version's set with reorder grips,
// a per-row ⋯ menu (Move up / Move down / Remove — the keyboard and accessibility fallback for the
// drag, SPEC §9.4), per-joke times, remove buttons and the footer totals (total, words, target,
// delta, progress). Desktop renders it as a collapsible right sidebar, mobile as the Set tab.
import { html, useRef, useMemo, useState, useEffect, useLayoutEffect } from '../lib.js';
import { setEstimate, formatDuration, formatDelta } from '../timing.js';
import { createDnd } from './dnd.js';
import { Icon, IconButton, Menu, plural, useUi } from './common.js';

const ON_TARGET_SEC = 5;

/** Delta text and state for the set total vs. the target: { text, state: 'over'|'under'|'ok' }. */
export function describeDelta(deltaSec) {
  if (Math.abs(deltaSec) <= ON_TARGET_SEC) return { text: 'on target', state: 'ok' };
  if (deltaSec > 0) return { text: `${formatDelta(deltaSec)} over`, state: 'over' };
  return { text: `${formatDelta(deltaSec)} under`, state: 'under' };
}

/** Progress-bar colour state for total/target: neutral under 85 %, green 85–105 %, red above. */
export function barState(ratio) {
  if (ratio < 0.85) return 'neutral';
  if (ratio <= 1.05) return 'ok';
  return 'over';
}

/**
 * @param {object} props
 * @param {object} props.ws
 * @param {boolean} props.isMobile
 * @param {boolean} props.collapsed            desktop sidebar collapsed
 * @param {() => void} props.onToggleCollapsed
 * @param {(jokeId: string) => void} props.onReveal
 */
export function SetPanel({ ws, isMobile, collapsed = false, onToggleCollapsed, onReveal }) {
  const { store } = useUi();
  const estimate = useMemo(() => setEstimate(ws), [ws]);
  const dnd = useMemo(() => createDnd({ onDrop: ({ id, index }) => store.actions.moveInSet(id, index) }), [store]);
  useEffect(() => () => dnd.destroy(), [dnd]);

  const delta = describeDelta(estimate.deltaSec);
  const ratio = estimate.ratio;
  const toggle = !isMobile
    ? html`<${IconButton} icon=${collapsed ? 'chevronLeft' : 'chevronRight'} label=${collapsed ? 'Show set' : 'Hide set'} testid="set-toggle" class="set-toggle" onClick=${onToggleCollapsed} />`
    : null;

  if (collapsed && !isMobile) {
    return html`<aside class="set-panel is-collapsed" data-testid="set-panel" data-collapsed="true" aria-label="Set">
      ${toggle}
      <button type="button" class="set-rail" onClick=${onToggleCollapsed} title="Show set">
        <span class="set-rail-label">Set</span>
        <span class="set-rail-total ${delta.state}">${formatDuration(estimate.totalSec)}</span>
      </button>
    </aside>`;
  }

  return html`<aside class="set-panel" data-testid="set-panel" data-collapsed="false" aria-label="Set">
    <header class="set-head">
      <h2>Set</h2>
      <span class="set-count">${plural(estimate.items.length, 'joke')}</span>
      <span class="spacer"></span>
      ${toggle}
    </header>
    <div class="set-list" data-drop="set">
      ${estimate.items.length === 0
        ? html`<p class="set-empty">Tick 'In set' on a joke to build your set.</p>`
        : estimate.items.map((item, i) => html`<${SetRow} key=${item.jokeId} item=${item} position=${i + 1} count=${estimate.items.length} dnd=${dnd}
            onReveal=${() => onReveal(item.jokeId)} onRemove=${() => store.actions.removeFromSet(item.jokeId)} />`)}
    </div>
    <footer class="set-foot">
      <div class="set-total-row">
        <span class="set-total-label">Total</span>
        <strong class="set-total" data-testid="set-total">${formatDuration(estimate.totalSec)}</strong>
      </div>
      <div class="set-meta">
        <span data-testid="set-words">${estimate.words} words</span>
        <span class="dot">·</span>
        <span>target <span data-testid="set-target">${formatDuration(estimate.targetSec)}</span></span>
        <span class="dot">·</span>
        <span class="set-delta ${delta.state}" data-testid="set-delta">${delta.text}</span>
      </div>
      <div class="set-bar" data-testid="set-bar" data-state=${barState(ratio)} role="progressbar" aria-label="Set length against target"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(Math.min(1, ratio) * 100)}>
        <div class="set-bar-fill" style=${{ width: `${Math.min(100, ratio * 100)}%` }}></div>
      </div>
    </footer>
  </aside>`;
}

/** One set row; `position` is 1-based, `count` the number of rows. */
function SetRow({ item, position, count, dnd, onReveal, onRemove }) {
  const { store, focus } = useUi();
  const rowRef = useRef(null);
  const gripRef = useRef(null);
  const menuButtonRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useLayoutEffect(() => {
    const grip = gripRef.current;
    dnd.attach(grip, { kind: 'set', id: item.jokeId, cardEl: rowRef.current });
    return () => dnd.detach(grip);
  }, [dnd, item.jokeId]);
  // Move up / Move down re-insert this row's DOM node among its siblings, which can drop keyboard
  // focus; the request made before the move puts it back on the ⋯ button once the row has settled.
  useLayoutEffect(() => {
    if (focus.take(item.jokeId, 'set-menu')) menuButtonRef.current.focus({ preventScroll: true });
  }, [position]); // eslint-disable-line react-hooks/exhaustive-deps

  // moveInSet takes the index in the list AFTER this row was removed from it (SPEC §3).
  const move = (toIndex) => {
    focus.request(item.jokeId, 'set-menu');
    store.actions.moveInSet(item.jokeId, toIndex);
  };
  const menuItems = [
    { label: 'Move up', action: 'move-up', disabled: position === 1, onSelect: () => move(position - 2) },
    { label: 'Move down', action: 'move-down', disabled: position === count, onSelect: () => move(position) },
    { divider: true },
    { label: 'Remove from set', action: 'remove', danger: true, onSelect: onRemove },
  ];

  return html`<div class="set-item" data-card data-card-header data-testid="set-item" data-id=${item.jokeId} ref=${rowRef}>
    <span class="set-pos">${position}</span>
    <button type="button" class="grip" data-testid="set-grip" aria-label="Drag to reorder" ref=${gripRef}><${Icon} name="grip" size=${16} /></button>
    <button type="button" class="set-title" data-testid="set-title" onClick=${onReveal} title="Show on board">
      <span class="set-title-text">${item.title}</span>
      ${item.topicTitle ? html`<span class="set-topic">${item.topicTitle}</span>` : null}
    </button>
    <span class="set-time ${item.overridden ? 'overridden' : ''}" data-testid="set-time" title=${item.overridden ? 'Manual time' : undefined}>${formatDuration(item.seconds)}</span>
    <${IconButton} icon="more" label="Set item menu" testid="set-menu" size=${16} class="set-menu" buttonRef=${menuButtonRef}
      onClick=${() => setMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded=${menuOpen} />
    ${menuOpen ? html`<${Menu} anchor=${menuButtonRef.current} items=${menuItems} label="Set item menu" onClose=${() => setMenuOpen(false)} />` : null}
    <${IconButton} icon="close" label="Remove from set" testid="set-remove" size=${16} class="set-remove" onClick=${onRemove} />
  </div>`;
}
