// Boot (SPEC §2, §6, §9.1, §10): load the workspace, create the store and sync manager, apply
// theme/column width, wire keyboard shortcuts, the visual-viewport (keyboard) variables, the
// flush-on-hide listeners and the service-worker update flow, then render <App/>.
import { html, render } from './lib.js';
import { downloadJson, loadWorkspace, saveWorkspace, serializeExport, SYNC_KEY } from './storage.js';
import { createStore } from './store.js';
import { createSyncManager } from './syncManager.js';
import { App } from './ui/App.js';
import { MOBILE_QUERY, createFocusRequests, createToaster, isTextField } from './ui/common.js';

const SAVE_TOAST_INTERVAL_MS = 60_000;
const SW_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const KEYBOARD_OPEN_PX = 100;

// ---------------------------------------------------------------------------
// Sync config (ssb.sync.v1) persistence hooks

function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSyncConfig(cfg) {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
  } catch {
    // Storage unavailable: the token lives for this session only.
  }
}

// ---------------------------------------------------------------------------
// Theme and column width

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const mobileQuery = typeof matchMedia === 'function' ? matchMedia(MOBILE_QUERY) : null;

/**
 * Applies settings that live on the document: resolved theme, the board column width and the
 * `theme-color` meta, which must match the top bar (§9.1) and therefore follows the theme's
 * `--topbar` token instead of repeating its value here.
 */
function applySettings(settings) {
  const root = document.documentElement;
  const theme = settings.theme === 'system' ? (darkQuery && darkQuery.matches ? 'dark' : 'light') : settings.theme;
  root.dataset.theme = theme;
  root.style.setProperty('--col-w', `${settings.colWidth}px`);
  const meta = document.querySelector('meta[name="theme-color"]');
  const topbar = getComputedStyle(root).getPropertyValue('--topbar').trim();
  if (meta && topbar) meta.content = topbar;
}

// ---------------------------------------------------------------------------
// Visual viewport → CSS variables (mobile keyboard handling, §9.1)

function setupViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const update = () => {
    const height = vv ? vv.height : window.innerHeight;
    const inset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    const keyboardOpen = inset > KEYBOARD_OPEN_PX;
    root.style.setProperty('--vvh', `${Math.round(height)}px`);
    root.style.setProperty('--kb-inset', `${Math.round(inset)}px`);
    root.classList.toggle('kb-open', keyboardOpen);
    if (vv && vv.offsetTop > 0) window.scrollTo(0, 0);
    // The app just shrank to the visual viewport and the browser's own reveal pan was cancelled
    // above, so bring the field being edited back into view inside its own scroller (the column
    // or the More page); the window itself never scrolls. Re-run on every resize while the
    // keyboard is open because iOS reports the final keyboard height over several events.
    const active = document.activeElement;
    if (keyboardOpen && mobileQuery && mobileQuery.matches && isTextField(active)) {
      active.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  };
  if (vv) {
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
  }
  window.addEventListener('resize', update);
  update();
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (§9.3): app undo/redo outside text fields; fields keep native undo.

function setupShortcuts(store) {
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (isTextField(e.target)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      store.undo();
    } else if ((key === 'z' && e.shiftKey) || key === 'y') {
      e.preventDefault();
      store.redo();
    }
  });
}

// ---------------------------------------------------------------------------
// Service worker registration + update flow (§10)

async function registerServiceWorker(toaster, store) {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  // A controller change after a SKIP_WAITING is the new version taking over: reload once. The very
  // first install also claims the page (clients.claim()); that is not an update, so it is ignored.
  let controlled = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    if (!controlled) {
      controlled = true;
      return;
    }
    refreshing = true;
    store.flush();
    location.reload();
  });
  let reg;
  try {
    reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    console.warn('Service worker registration failed', err);
    return;
  }
  const offerUpdate = () => {
    toaster.show({
      key: 'sw-update',
      message: 'Update available',
      persistent: true,
      action: { label: 'Reload', onClick: () => reg.waiting && reg.waiting.postMessage({ type: 'SKIP_WAITING' }) },
    });
  };
  if (reg.waiting && navigator.serviceWorker.controller) offerUpdate();
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate();
    });
  });
  let lastCheck = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastCheck < SW_UPDATE_INTERVAL_MS) return;
    lastCheck = Date.now();
    reg.update().catch(() => undefined);
  });
}

// ---------------------------------------------------------------------------
// Boot

function boot() {
  const toaster = createToaster();
  const focus = createFocusRequests();

  let lastSaveToastAt = 0;
  const store = createStore(loadWorkspace(), {
    persist: (ws) => saveWorkspace(ws),
    onPersistError: (err) => {
      console.error('Persist failed', err);
      if (Date.now() - lastSaveToastAt < SAVE_TOAST_INTERVAL_MS) return;
      lastSaveToastAt = Date.now();
      toaster.show({
        key: 'save-error',
        message: 'Couldn’t save on this device (storage full?) — export your data',
        persistent: true,
        action: {
          label: 'Export',
          onClick: () => downloadJson('standup-set-builder-backup.json', serializeExport(store.get())),
        },
      });
    },
  });

  const syncManager = createSyncManager({
    store,
    loadConfig: loadSyncConfig,
    saveConfig: saveSyncConfig,
    onConflictCopies: (names) => names.forEach((name) => toaster.show({ message: `Kept a conflict copy: ${name}`, persistent: true })),
  });

  applySettings(store.get().settings);
  store.subscribe((ws) => applySettings(ws.settings));
  if (darkQuery) darkQuery.addEventListener('change', () => applySettings(store.get().settings));

  setupViewport();
  setupShortcuts(store);
  window.addEventListener('pagehide', () => store.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.flush();
  });

  render(html`<${App} store=${store} syncManager=${syncManager} toaster=${toaster} focus=${focus} />`, document.getElementById('app'));
  window.__ssbBooted = true;
  const fallback = document.getElementById('boot-fallback');
  if (fallback) fallback.hidden = true;

  if (navigator.storage && typeof navigator.storage.persist === 'function') navigator.storage.persist().catch(() => undefined);
  syncManager.start();
  registerServiceWorker(toaster, store);
}

boot();
