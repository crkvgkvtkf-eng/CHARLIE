// Layout shell (SPEC §9.1, §9.2, §9.8): top bar, board, set sidebar / tabs, More view, dialogs,
// toasts and the desktop ↔ mobile switch. Owns the UI-only state that spans views (current tab,
// sidebar collapse, reveal requests, open dialogs, install nudge) and provides the UiContext.
import { html, useState, useMemo, useCallback } from '../lib.js';
import { activeVersion } from '../model.js';
import { formatDuration, setEstimate } from '../timing.js';
import { Board } from './Board.js';
import { SetPanel, describeDelta } from './SetPanel.js';
import { Settings } from './Settings.js';
import { ManageVersionsDialog, NewVersionDialog, VersionSwitcher } from './Versions.js';
import {
  Dialog, Icon, IconButton, MOBILE_QUERY, ToastHost, UiContext, readLocal, useDialogs, useMediaQuery, useStore,
  useSyncStatus, writeLocal,
} from './common.js';

const SET_COLLAPSED_KEY = 'ssb.ui.setCollapsed';
const NUDGE_DISMISSED_KEY = 'ssb.ui.installNudgeDismissed';
const SIDEBAR_AUTO_COLLAPSE_PX = 1100;
const NUDGE_TEXT = 'Install to your Home Screen or connect Sync. Safari may delete this app’s local data after 7 days without a visit, '
  + 'and the installed app starts empty — export here and import there, or connect Sync on both.';

/** True when running as an installed app (home screen / dock). */
function isStandalone() {
  return Boolean(navigator.standalone) || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
}

/** Install nudge condition (§9.1): not installed, touch device, has jokes, sync off, not dismissed. */
function shouldNudge(ws, syncState) {
  if (isStandalone()) return false;
  if (!((navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window)) return false;
  if (readLocal(NUDGE_DISMISSED_KEY, false) === true) return false;
  const jokes = ws.versions.reduce((n, v) => n + v.topics.reduce((m, t) => m + t.jokes.length, 0), 0);
  return jokes >= 1 && syncState === 'off';
}

const SYNC_LABELS = { off: 'Sync off', idle: 'Synced', syncing: 'Syncing…', error: 'Sync error', offline: 'Offline' };

/**
 * @param {object} props
 * @param {object} props.store
 * @param {object} props.syncManager
 * @param {object} props.toaster      from createToaster()
 * @param {object} props.focus        from createFocusRequests()
 */
export function App({ store, syncManager, toaster, focus }) {
  const ws = useStore(store);
  const syncStatus = useSyncStatus(syncManager);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const dialogs = useDialogs();

  const [view, setView] = useState('board'); // mobile: 'board' | 'set' | 'more'
  const [moreSection, setMoreSection] = useState(null);
  const [topicIndex, setTopicIndex] = useState(0);
  const [setCollapsed, setSetCollapsed] = useState(() => {
    const stored = readLocal(SET_COLLAPSED_KEY, null);
    return typeof stored === 'boolean' ? stored : window.innerWidth < SIDEBAR_AUTO_COLLAPSE_PX;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [newVersionOpen, setNewVersionOpen] = useState(false);
  const [reveal, setReveal] = useState(null);
  const [nudge, setNudge] = useState(() => shouldNudge(store.get(), syncManager.getStatus().state));

  const ui = useMemo(() => ({
    store, syncManager, toaster, focus, confirm: dialogs.confirm, prompt: dialogs.prompt, isMobile,
  }), [store, syncManager, toaster, focus, dialogs.confirm, dialogs.prompt, isMobile]);

  const toggleSetCollapsed = () => {
    setSetCollapsed((v) => {
      writeLocal(SET_COLLAPSED_KEY, !v);
      return !v;
    });
  };
  const openSyncSettings = () => {
    if (isMobile) {
      setMoreSection('sync');
      setView('more');
    } else {
      setSettingsSection('sync');
      setSettingsOpen(true);
    }
  };
  const openSettings = () => {
    setSettingsSection(null);
    setSettingsOpen(true);
  };
  const onReveal = useCallback((jokeId) => {
    setReveal({ jokeId, nonce: Date.now() });
    if (isMobile) setView('board');
  }, [isMobile]);
  const onRevealed = useCallback(() => setReveal(null), []);
  const dismissNudge = () => {
    writeLocal(NUDGE_DISMISSED_KEY, true);
    setNudge(false);
  };

  const estimate = setEstimate(ws);
  const delta = describeDelta(estimate.deltaSec);
  const version = activeVersion(ws);

  const topBar = html`<header class="topbar ${isMobile ? 'compact' : ''}">
    ${isMobile ? null : html`<div class="brand"><img class="brand-icon" src="./icons/icon.svg" alt="" width="22" height="22" /> Set Builder</div>`}
    <${VersionSwitcher} ws=${ws} onNew=${() => setNewVersionOpen(true)} onManage=${() => setVersionsOpen(true)} />
    <span class="spacer"></span>
    <${IconButton} icon="undo" label="Undo" title="Undo (⌘/Ctrl+Z)" testid="undo" disabled=${!store.canUndo()} onClick=${() => store.undo()} />
    <${IconButton} icon="redo" label="Redo" title="Redo (Shift+⌘/Ctrl+Z)" testid="redo" disabled=${!store.canRedo()} onClick=${() => store.redo()} />
    <button type="button" class="sync-dot" data-testid="sync-dot" data-state=${syncStatus.state} onClick=${openSyncSettings}
      aria-label=${`${SYNC_LABELS[syncStatus.state] || 'Sync'} — open sync settings`} title=${syncStatus.error || SYNC_LABELS[syncStatus.state]}></button>
    ${isMobile ? null : html`<${IconButton} icon="gear" label="Settings" testid="settings-button" onClick=${openSettings} />`}
  </header>`;

  const board = html`<${Board} ws=${ws} isMobile=${isMobile} initialTopicIndex=${topicIndex} onTopicIndexChange=${setTopicIndex}
    reveal=${reveal} onRevealed=${onRevealed} />`;

  let main;
  if (!isMobile) {
    main = html`<main class="main">
      ${board}
      <${SetPanel} ws=${ws} isMobile=${false} collapsed=${setCollapsed} onToggleCollapsed=${toggleSetCollapsed} onReveal=${onReveal} />
    </main>`;
  } else if (view === 'set') {
    main = html`<main class="main"><${SetPanel} ws=${ws} isMobile=${true} onReveal=${onReveal} /></main>`;
  } else if (view === 'more') {
    main = html`<main class="main">
      <div class="more scroll-col">
        <button type="button" class="row-btn more-versions" onClick=${() => setVersionsOpen(true)}>
          <span>Versions</span>
          <span class="row-value">${version.name} <${Icon} name="chevronRight" size=${16} /></span>
        </button>
        <${Settings} ws=${ws} isMobile=${true} section=${moreSection} />
      </div>
    </main>`;
  } else {
    main = html`<main class="main">${board}</main>`;
  }

  const tabBar = isMobile
    ? html`<nav class="tabbar" aria-label="Views">
        <button type="button" class="tab" data-testid="tab-board" aria-current=${view === 'board' ? 'page' : undefined} onClick=${() => setView('board')}>
          <${Icon} name="board" size=${22} /><span>Board</span>
        </button>
        <button type="button" class="tab" data-testid="tab-set" aria-current=${view === 'set' ? 'page' : undefined} onClick=${() => setView('set')}>
          <${Icon} name="list" size=${22} /><span>Set · <span class="tab-time ${delta.state}">${formatDuration(estimate.totalSec)}</span></span>
        </button>
        <button type="button" class="tab" data-testid="tab-more" aria-current=${view === 'more' ? 'page' : undefined} onClick=${() => { setMoreSection(null); setView('more'); }}>
          <${Icon} name="dots" size=${22} /><span>More</span>
          ${syncStatus.state === 'error' ? html`<span class="tab-badge" aria-label="Sync error"></span>` : null}
        </button>
      </nav>`
    : null;

  return html`<${UiContext.Provider} value=${ui}>
    <div class="app ${isMobile ? 'is-mobile' : 'is-desktop'}" data-testid="app">
      ${topBar}
      ${nudge ? html`<div class="install-nudge" data-testid="install-nudge" role="note">
        <span>${NUDGE_TEXT}</span>
        <${IconButton} icon="close" label="Dismiss" testid="install-nudge-dismiss" size=${16} onClick=${dismissNudge} />
      </div>` : null}
      ${main}
      ${tabBar}
      <${ToastHost} toaster=${toaster} />
      ${dialogs.element}
      ${settingsOpen && !isMobile ? html`<${Dialog} onClose=${() => setSettingsOpen(false)} label="Settings" class="dialog-settings">
        <div class="dialog-head">
          <h2 class="dialog-title">Settings</h2>
          <button type="button" class="btn btn-small" onClick=${() => setSettingsOpen(false)}>Done</button>
        </div>
        <${Settings} ws=${ws} isMobile=${false} section=${settingsSection} />
      <//>` : null}
      ${versionsOpen ? html`<${ManageVersionsDialog} ws=${ws} onClose=${() => setVersionsOpen(false)} />` : null}
      ${newVersionOpen ? html`<${NewVersionDialog} ws=${ws} onClose=${() => setNewVersionOpen(false)} />` : null}
    </div>
  <//>`;
}
