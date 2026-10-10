// Shared UI primitives (SPEC §9.8, §9.3 AutoTextarea, §12): native <dialog> wrapper, popover Menu,
// toasts, icon buttons, the auto-growing textarea, the time chip, confirm/prompt helpers and the
// small hooks the views share (store subscription, sync status, media query, draft text fields,
// focus requests). Everything renders through Preact + htm from js/lib.js; no JSX, no build.
import { html, createContext, useContext, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from '../lib.js';
import { formatDuration } from '../timing.js';

export const MOBILE_QUERY = '(max-width: 767.98px)';
const TOAST_MS = 3000;
const TOAST_WITH_ACTION_MS = 8000;
const MAX_TOASTS = 3;
const MENU_MARGIN_PX = 8;
const MENU_GAP_PX = 4; // between the anchor and the menu
const MENU_MIN_HEIGHT_PX = 120; // a menu squeezed harder than this would be unusable; it may then overlap

/** Height of the part of the page the user can actually see (the visual viewport shrinks under the iOS keyboard). */
function visibleHeight() {
  const vv = window.visualViewport;
  return vv && vv.height > 0 ? vv.height : window.innerHeight;
}

/**
 * True while `el` is on screen: inside the visual viewport and not clipped away by any scrolling or
 * clipping ancestor. An unmounted element (empty rect) counts as gone.
 */
function isOnScreen(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const outside = (b) => r.bottom <= b.top || r.top >= b.bottom || r.right <= b.left || r.left >= b.right;
  if (outside({ top: 0, left: 0, right: window.innerWidth, bottom: visibleHeight() })) return false;
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!/auto|scroll|hidden|clip/.test(style.overflowX + style.overflowY)) continue;
    if (outside(node.getBoundingClientRect())) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// App-wide context: store, sync manager, toaster, dialogs, focus requests, layout mode.

export const UiContext = createContext(null);

/** The app services handed down by App.js: { store, syncManager, toaster, confirm, prompt, focus, isMobile }. */
export function useUi() {
  return useContext(UiContext);
}

// ---------------------------------------------------------------------------
// Hooks

/** The current workspace snapshot; re-renders on every store notification. */
export function useStore(store) {
  const [ws, setWs] = useState(() => store.get());
  useEffect(() => {
    setWs(store.get()); // a change between the first render and subscribing is not lost
    return store.subscribe((snapshot) => setWs(snapshot));
  }, [store]);
  return ws;
}

/** The sync manager's status, kept current through its subscription. */
export function useSyncStatus(mgr) {
  const [status, setStatus] = useState(() => mgr.getStatus());
  useEffect(() => {
    setStatus(mgr.getStatus());
    return mgr.subscribe(setStatus);
  }, [mgr]);
  return status;
}

/** Whether a media query currently matches (updates live). */
export function useMediaQuery(query) {
  const mql = useMemo(() => (typeof matchMedia === 'function' ? matchMedia(query) : null), [query]);
  const [matches, setMatches] = useState(() => Boolean(mql && mql.matches));
  useEffect(() => {
    if (!mql) return undefined;
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [mql]);
  return matches;
}

/** Reads a JSON value from localStorage; `fallback` when missing, unparsable or storage is unavailable. */
export function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Writes a JSON value to localStorage, ignoring failures (private mode, quota). */
export function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Per-device conveniences only; losing them is harmless.
  }
}

/**
 * Local draft state for a controlled text field. The draft follows the store value whenever the
 * store changes underneath (undo, sync, import) and otherwise holds what the user typed, so a
 * commit that the store rejects or coalesces never snaps the caret back.
 */
export function useDraft(value) {
  const [draft, setDraft] = useState(value);
  const seen = useRef(value);
  useLayoutEffect(() => {
    if (seen.current !== value) {
      seen.current = value;
      setDraft(value);
    }
  }, [value]);
  return [draft, setDraft];
}

/**
 * Focus requests for elements that do not exist yet (SPEC §9.3): the handler that creates the
 * entity records { id, field }; the component that mounts the field claims it from a layout
 * effect in the very commit that mounts it, so iOS still treats the focus as user-initiated.
 */
export function createFocusRequests() {
  let pending = null;
  return {
    request(id, field) {
      pending = { id, field };
    },
    /** True (and clears the request) when the pending request matches. */
    take(id, field) {
      if (pending && pending.id === id && pending.field === field) {
        pending = null;
        return true;
      }
      return false;
    },
  };
}

/** Focuses `ref` on mount when a focus request for (id, field) is pending. */
export function useMountFocus(ref, id, field) {
  const ui = useUi();
  useLayoutEffect(() => {
    if (ui && ui.focus.take(id, field)) focusField(ref.current);
    // Mount-only by design: the request is consumed in the commit that creates the element.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Focus a text field and put the caret at its end (iOS keeps it at 0 otherwise). */
export function focusField(el) {
  if (!el) return;
  el.focus();
  if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
    const end = el.value.length;
    try {
      el.setSelectionRange(end, end);
    } catch {
      // Some input types refuse selection ranges; focusing was the point.
    }
  }
}

/** True for elements whose native undo/typing must not be hijacked by app shortcuts. */
export function isTextField(el) {
  if (!el || typeof el.closest !== 'function') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'range', 'file', 'color'].includes(el.type);
  return false;
}

// ---------------------------------------------------------------------------
// Icons (inline SVG, currentColor)

const ICON_PATHS = {
  grip: 'M9 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm9 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM9 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm9 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-9 6.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm9 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z',
  more: 'M7 12a1.75 1.75 0 1 1-3.5 0A1.75 1.75 0 0 1 7 12Zm6.75 0a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Zm6.75 0a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Z',
  undo: 'M9 14 4 9l5-5M4 9h9a6 6 0 0 1 0 12h-2',
  redo: 'm15 14 5-5-5-5M20 9h-9a6 6 0 0 0 0 12h2',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-3.5a7.6 7.6 0 0 0-.1-1.1l2.1-1.6-2-3.5-2.5 1a7.8 7.8 0 0 0-1.9-1.1L14.6 2H9.4l-.4 2.7a7.8 7.8 0 0 0-1.9 1.1l-2.5-1-2 3.5 2.1 1.6a7.6 7.6 0 0 0 0 2.2l-2.1 1.6 2 3.5 2.5-1a7.8 7.8 0 0 0 1.9 1.1l.4 2.7h5.2l.4-2.7a7.8 7.8 0 0 0 1.9-1.1l2.5 1 2-3.5-2.1-1.6c.1-.4.1-.7.1-1.1Z',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  check: 'm5 12 5 5L20 7',
  chevronLeft: 'm15 5-7 7 7 7',
  chevronRight: 'm9 5 7 7-7 7',
  chevronDown: 'm5 9 7 7 7-7',
  board: 'M4 5h16v4H4zM4 13h7v6H4zM13 13h7v6h-7z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  dots: 'M12 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 6.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 6.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  timer: 'M12 8v5l3 2M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM9 2h6',
};
const FILLED_ICONS = new Set(['grip', 'more', 'gear', 'dots']);

/** A 24×24 line icon. `name` is a key of ICON_PATHS. */
export function Icon({ name, size = 20 }) {
  const filled = FILLED_ICONS.has(name);
  return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    fill=${filled ? 'currentColor' : 'none'} stroke=${filled ? 'none' : 'currentColor'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d=${ICON_PATHS[name]} />
  </svg>`;
}

/** Icon-only button with an accessible name (SPEC §12: every icon button has aria-label). */
export function IconButton({ label, icon, onClick, disabled = false, testid, class: cls = '', title, size, buttonRef, ...rest }) {
  return html`<button type="button" class="icon-btn ${cls}" aria-label=${label} title=${title ?? label}
    disabled=${disabled} onClick=${onClick} data-testid=${testid} ref=${buttonRef} ...${rest}>
    <${Icon} name=${icon} size=${size} />
  </button>`;
}

// ---------------------------------------------------------------------------
// AutoTextarea: CSS grid replicated-value auto-grow (no JS measurement).

/**
 * A textarea that grows with its content. The wrapper is a grid whose ::after pseudo-element
 * mirrors the value (via data-value) in the same cell with the same font and padding, so the
 * wrapper's height follows the text and the textarea simply fills it.
 */
export function AutoTextarea({ value, onInput, class: cls = '', wrapClass = '', textareaRef, ...rest }) {
  return html`<div class="grow ${wrapClass}" data-value=${value}>
    <textarea class=${cls} value=${value} onInput=${onInput} rows="1" ref=${textareaRef} ...${rest}></textarea>
  </div>`;
}

// ---------------------------------------------------------------------------
// TimeChip

/** "0:24 · 56w"; a manual override is marked with a timer icon and the tooltip "Manual time". */
export function TimeChip({ seconds, words, overridden = false, testid, class: cls = '' }) {
  return html`<span class="chip time-chip ${overridden ? 'overridden' : ''} ${cls}" data-testid=${testid} title=${overridden ? 'Manual time' : undefined}>
    ${overridden ? html`<${Icon} name="timer" size=${13} />` : null}${formatDuration(seconds)} · ${words}w
  </span>`;
}

// ---------------------------------------------------------------------------
// Dialog: native <dialog> opened with showModal() (inert background, Esc, focus trap for free).

/** Open modal dialog elements, outermost first. Toasts render inside the last one (see ToastHost). */
const openDialogs = [];
const dialogListeners = new Set();

function setDialogOpen(el, open) {
  const i = openDialogs.indexOf(el);
  if (open && i === -1) openDialogs.push(el);
  else if (!open && i !== -1) openDialogs.splice(i, 1);
  else return;
  dialogListeners.forEach((fn) => fn());
}

/** The topmost open modal dialog element (null when none); the caller re-renders when it changes. */
function useTopDialog() {
  const topmost = () => openDialogs[openDialogs.length - 1] ?? null;
  const [top, setTop] = useState(topmost);
  useEffect(() => {
    const update = () => setTop(topmost());
    update();
    dialogListeners.add(update);
    return () => dialogListeners.delete(update);
  }, []);
  return top;
}

/**
 * Renders its children inside an open modal dialog. Mount = open; the owner unmounts it to close.
 * `onClose` fires for Esc (the `cancel` event) and for clicks on the backdrop.
 */
export function Dialog({ onClose, label, testid = 'dialog', class: cls = '', children }) {
  const ref = useRef(null);
  const ui = useUi();
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    setDialogOpen(el, true);
    return () => {
      setDialogOpen(el, false);
      if (el && el.open) el.close();
    };
  }, []);
  const onCancel = (e) => {
    e.preventDefault(); // the owner removes the element; a native close would leave stale state
    onClose();
  };
  const onClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };
  return html`<dialog ref=${ref} class="dialog ${cls}" aria-label=${label} data-testid=${testid} onCancel=${onCancel} onClick=${onClick}>
    <div class="dialog-body">${children}</div>
    ${ui ? html`<${ToastHost} toaster=${ui.toaster} hostRef=${ref} />` : null}
  </dialog>`;
}

/**
 * Confirm / prompt dialogs as promises. Returns { confirm, prompt, element }: render `element`
 * once (it is the host for whichever request is open) and await the helpers from any handler.
 *   confirm({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger }) → Promise<boolean>
 *   prompt({ title, message, defaultValue = '', placeholder, confirmLabel = 'OK' }) → Promise<string|null>
 */
export function useDialogs() {
  const [request, setRequest] = useState(null);
  const open = useCallback((req) => new Promise((resolve) => setRequest({ ...req, resolve })), []);
  const confirm = useCallback((opts) => open({ ...opts, kind: 'confirm' }), [open]);
  const prompt = useCallback((opts) => open({ ...opts, kind: 'prompt' }), [open]);
  const done = (value) => {
    if (!request) return;
    setRequest(null);
    request.resolve(value);
  };
  const element = request ? html`<${PromptDialog} key=${request.kind} request=${request} onDone=${done} />` : null;
  return { confirm, prompt, element };
}

function PromptDialog({ request, onDone }) {
  const isPrompt = request.kind === 'prompt';
  const [text, setText] = useState(request.defaultValue ?? '');
  const cancel = () => onDone(isPrompt ? null : false);
  const submit = (e) => {
    e.preventDefault();
    onDone(isPrompt ? text : true);
  };
  return html`<${Dialog} onClose=${cancel} label=${request.title} class="dialog-small">
    <form class="dialog-form" onSubmit=${submit}>
      <h2 class="dialog-title">${request.title}</h2>
      ${request.message ? html`<p class="dialog-message">${request.message}</p>` : null}
      ${isPrompt
        ? html`<input class="input" type="text" data-testid="dialog-input" autofocus value=${text}
            placeholder=${request.placeholder} inputmode=${request.inputMode} onInput=${(e) => setText(e.target.value)} />`
        : null}
      <div class="dialog-actions">
        <button type="button" class="btn" data-testid="dialog-cancel" onClick=${cancel}>${request.cancelLabel ?? 'Cancel'}</button>
        <button type="submit" class="btn ${request.danger ? 'btn-danger' : 'btn-primary'}" data-testid="dialog-confirm" autofocus=${!isPrompt}>
          ${request.confirmLabel ?? 'OK'}
        </button>
      </div>
    </form>
  <//>`;
}

// ---------------------------------------------------------------------------
// Menu: a popover anchored to a button, keyboard navigable, with one level of submenus.

/**
 * @param {object} props
 * @param {Element} props.anchor         the button the menu belongs to (for positioning and focus return)
 * @param {Array} props.items            [{ label, action, target, testid, data, onSelect, disabled, danger, checked, submenu, swatch },
 *                                        { divider: true }, { header }, { swatches: [{ label, action, swatch, checked, onSelect }] }]
 * @param {(reason: 'select'|'escape'|'outside') => void} props.onClose
 * @param {string} [props.label]         accessible name
 */
export function Menu({ anchor, items, onClose, label = 'Menu' }) {
  const ref = useRef(null);
  const [path, setPath] = useState([]); // stack of opened submenu items
  const visible = useMemo(() => {
    const parent = path[path.length - 1];
    if (!parent) return items;
    return [{ label: parent.label, back: true }, { divider: true }, ...parent.submenu];
  }, [items, path]);

  // Position next to the anchor, clamped to the visible part of the viewport (not the part under
  // the iOS keyboard). The menu opens below the anchor, else above it; when it fits neither way it
  // takes the roomier side and shrinks to that room (it scrolls inside), so it never covers the
  // button that opened it: a second tap on the button must close the menu, not land on whatever
  // item happens to lie over the button.
  const place = () => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = visibleHeight();
    const a = anchor ? anchor.getBoundingClientRect() : { left: vw / 2, right: vw / 2, top: vh / 2, bottom: vh / 2 };
    const below = vh - MENU_MARGIN_PX - (a.bottom + MENU_GAP_PX);
    const above = a.top - MENU_GAP_PX - MENU_MARGIN_PX;
    el.style.maxHeight = `${Math.max(below, above, MENU_MIN_HEIGHT_PX)}px`;
    const r = el.getBoundingClientRect();
    let left = a.right - r.width;
    if (left < MENU_MARGIN_PX) left = Math.min(a.left, vw - r.width - MENU_MARGIN_PX);
    left = Math.max(MENU_MARGIN_PX, left);
    let top = r.height <= below || below >= above ? a.bottom + MENU_GAP_PX : a.top - MENU_GAP_PX - r.height;
    top = Math.max(MENU_MARGIN_PX, Math.min(top, vh - MENU_MARGIN_PX - r.height));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  };
  useLayoutEffect(place, [anchor, visible]);

  // Focus the first item when the menu opens and whenever a submenu level is entered or left.
  // Deliberately not tied to `visible`: the items array is rebuilt on every parent render (a
  // sync status change, an undo), and refocusing then would throw away arrow-key navigation.
  useLayoutEffect(() => {
    const first = ref.current && ref.current.querySelector('.menu-item:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }, [path.length]);

  /** Hands keyboard focus back to the button that opened the menu (its items are about to unmount). */
  const focusAnchor = () => {
    if (anchor && typeof anchor.focus === 'function') anchor.focus({ preventScroll: true });
  };

  // Close on outside pointerdown and on Escape (wherever focus is: clicking a header or divider
  // moves focus out of the items, and Esc must still work then). Scrolls and resizes elsewhere do
  // NOT close the menu by themselves: the layout moves under an open menu whenever the on-screen
  // keyboard retracts (the column grows back and its scroll position is clamped), and the very tap
  // that opened a card menu while editing is what dismisses the keyboard. The menu follows its
  // anchor instead and closes only once the anchor has left the screen.
  useEffect(() => {
    const onDown = (e) => {
      const el = ref.current;
      if (el && !el.contains(e.target) && !(anchor && anchor.contains(e.target))) onClose('outside');
    };
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      focusAnchor();
      onClose('escape');
    };
    const onLayoutChange = (e) => {
      if (e.type === 'scroll' && ref.current && ref.current.contains(e.target)) return; // scrolling inside the menu
      if (anchor && !isOnScreen(anchor)) onClose('outside');
      else place();
    };
    const vv = window.visualViewport;
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onLayoutChange, true);
    window.addEventListener('resize', onLayoutChange);
    if (vv) vv.addEventListener('resize', onLayoutChange);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onLayoutChange, true);
      window.removeEventListener('resize', onLayoutChange);
      if (vv) vv.removeEventListener('resize', onLayoutChange);
    };
  }, [anchor, onClose]); // eslint-disable-line react-hooks/exhaustive-deps -- place/focusAnchor only read refs and `anchor`

  const select = (item) => {
    if (item.disabled) return;
    if (item.back) {
      setPath(path.slice(0, -1));
      return;
    }
    if (item.submenu) {
      setPath([...path, item]);
      return;
    }
    // Focus returns to the anchor before the action runs, so an action that focuses something
    // itself (Rename, a new joke's title, a confirm dialog) still wins.
    focusAnchor();
    if (item.onSelect) item.onSelect();
    onClose('select');
  };

  const onKeyDown = (e) => {
    const el = ref.current;
    const focusable = el ? Array.from(el.querySelectorAll('.menu-item:not([disabled])')) : [];
    const current = focusable.indexOf(document.activeElement);
    const go = (i) => focusable[(i + focusable.length) % focusable.length]?.focus();
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); go(current + 1); break;
      case 'ArrowUp': e.preventDefault(); go(current - 1); break;
      case 'Home': e.preventDefault(); go(0); break;
      case 'End': e.preventDefault(); go(focusable.length - 1); break;
      case 'ArrowLeft':
        if (path.length) { e.preventDefault(); setPath(path.slice(0, -1)); }
        break;
      case 'Tab':
        e.preventDefault();
        focusAnchor();
        onClose('outside');
        break;
      default:
        break;
    }
  };

  // A press on a header, divider or padding keeps keyboard focus on the current item (the default
  // would move it to <body>, and arrow keys would stop working); the root is focusable as a last
  // resort so key handling never leaves the menu while it is open.
  const onPointerDown = (e) => {
    if (!e.target.closest('.menu-item')) e.preventDefault();
  };

  return html`<div class="menu" role="menu" aria-label=${label} data-testid="menu" ref=${ref} tabindex="-1" onKeyDown=${onKeyDown} onPointerDown=${onPointerDown}>
    ${visible.map((item, i) => {
      if (item.divider) return html`<div class="menu-divider" role="separator" key=${`d${i}`}></div>`;
      if (item.header) return html`<div class="menu-header" key=${`h${i}`}>${item.header}</div>`;
      if (item.swatches) {
        return html`<div class="menu-swatches" role="group" aria-label=${item.label} key=${`s${i}`}>
          ${item.swatches.map((sw) => html`<button type="button" role="menuitemradio" key=${sw.action} class="menu-item swatch-item ${sw.checked ? 'checked' : ''}"
            data-testid="menu-item" data-action=${sw.action} aria-checked=${sw.checked} aria-label=${sw.label} title=${sw.label} onClick=${() => select(sw)}>
            <span class="swatch ${sw.swatch ? '' : 'swatch-none'}" data-color=${sw.swatch}></span>
          </button>`)}
        </div>`;
      }
      const data = item.data || {};
      return html`<button type="button" role="menuitem" key=${item.key ?? item.testid ?? `${item.action ?? item.target ?? i}`}
        class="menu-item ${item.danger ? 'danger' : ''} ${item.back ? 'back' : ''}"
        data-testid=${item.testid ?? 'menu-item'} data-action=${item.action} data-target=${item.target}
        data-id=${data.id} disabled=${item.disabled} aria-checked=${item.checked} aria-haspopup=${item.submenu ? 'menu' : undefined}
        onClick=${() => select(item)}>
        ${item.back ? html`<${Icon} name="chevronLeft" size=${16} />` : null}
        ${item.swatch ? html`<span class="swatch" data-color=${item.swatch}></span>` : null}
        <span class="menu-label">${item.label}</span>
        ${item.checked ? html`<${Icon} name="check" size=${16} />` : null}
        ${item.submenu ? html`<${Icon} name="chevronRight" size=${16} />` : null}
      </button>`;
    })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Toasts

/**
 * A tiny toast store usable from outside Preact (app.js, the sync manager). At most MAX_TOASTS
 * are kept; a new one with the same `key` replaces the old.
 *   show({ message, action: { label, onClick } | null, persistent, key }) → id
 */
export function createToaster() {
  let toasts = [];
  let seq = 0;
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn(toasts));
  return {
    show({ message, action = null, persistent = false, key = null }) {
      const id = ++seq;
      toasts = toasts.filter((t) => key === null || t.key !== key);
      toasts = [...toasts, { id, key, message, action, persistent }];
      while (toasts.length > MAX_TOASTS) toasts = toasts.slice(1);
      notify();
      return id;
    },
    dismiss(id) {
      if (!toasts.some((t) => t.id === id)) return;
      toasts = toasts.filter((t) => t.id !== id);
      notify();
    },
    get: () => toasts,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * Renders the toaster's toasts. A modal <dialog> makes everything outside it inert — a toast in
 * the normal document (or a popover shown on top) is then invisible behind the dialog or at best
 * unclickable — so each Dialog renders its own host inside the dialog element and only the host
 * belonging to the topmost open dialog (or the app-level one when none is open) shows the toasts.
 * @param {{ current: Element|null }} [hostRef]  the dialog element this host lives in; omitted for the app-level host
 */
export function ToastHost({ toaster, hostRef = null }) {
  const [toasts, setToasts] = useState(() => toaster.get());
  useEffect(() => {
    setToasts(toaster.get());
    return toaster.subscribe(setToasts);
  }, [toaster]);
  const top = useTopDialog();
  const active = hostRef ? hostRef.current !== null && top === hostRef.current : top === null;
  return html`<div class="toasts" aria-live="polite">
    ${active ? toasts.map((t) => html`<${Toast} key=${t.id} toast=${t} onDismiss=${() => toaster.dismiss(t.id)} />`) : null}
  </div>`;
}

/** One toast. Auto-dismisses unless persistent; the timer pauses while hovered or touched. */
export function Toast({ toast, onDismiss }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.action ? TOAST_WITH_ACTION_MS : TOAST_MS);
  useEffect(() => {
    if (toast.persistent || paused) return undefined;
    const startedAt = Date.now();
    const timer = setTimeout(onDismiss, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(500, remaining.current - (Date.now() - startedAt));
    };
  }, [paused, toast.persistent, onDismiss]);
  const pause = () => setPaused(true);
  const resume = () => setPaused(false);
  const act = () => {
    toast.action.onClick();
    onDismiss();
  };
  return html`<div class="toast" role="status" data-testid="toast"
    onPointerEnter=${pause} onPointerLeave=${resume} onTouchStart=${pause} onTouchEnd=${resume} onTouchCancel=${resume}>
    <span class="toast-text">${toast.message}</span>
    ${toast.action ? html`<button type="button" class="toast-action" data-testid="toast-action" onClick=${act}>${toast.action.label}</button>` : null}
    <${IconButton} icon="close" label="Dismiss" size=${16} class="toast-close" onClick=${onDismiss} />
  </div>`;
}

// ---------------------------------------------------------------------------
// Misc helpers

/** A joke's display name for lists and menus. */
export function jokeLabel(joke, fallback = 'Untitled joke') {
  const snippet = (joke.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return joke.title || snippet || fallback;
}

/** A topic's display name for lists and menus. */
export function topicLabel(topic, index) {
  return topic.title || `Topic ${index + 1}`;
}

/** "3 jokes" / "1 joke". */
export function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Short relative time ("just now", "5 min ago", "yesterday", or a date) for lists. */
export function relativeTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) return 'never';
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(ms).toLocaleDateString();
}
