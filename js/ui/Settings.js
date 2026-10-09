// Settings (SPEC §9.7): Pace, Sync, Data, Appearance and Help sections. Rendered inside a dialog
// on desktop and inline as the More view on mobile; `section` scrolls a section into view.
import { html, useState, useRef, useLayoutEffect } from '../lib.js';
import { nowIso } from '../ids.js';
import { createWorkspace, normalize } from '../model.js';
import { merge } from '../sync.js';
import { SYNC_KEY, downloadJson, parseImport, serializeExport } from '../storage.js';
import { formatDuration, parseDuration } from '../timing.js';
import { plural, relativeTime, useDraft, useSyncStatus, useUi } from './common.js';

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=Stand-Up%20Set%20Builder';
const PACE_RANGES = { wpm: [60, 300], pauseSec: [0, 30], targetSec: [1, 36000] };

const clamp = (n, [lo, hi]) => Math.min(hi, Math.max(lo, n));

/**
 * @param {object} props
 * @param {object} props.ws
 * @param {boolean} props.isMobile
 * @param {string|null} [props.section]   'pace' | 'sync' | 'data' | 'appearance' | 'help' to scroll to on mount
 */
export function Settings({ ws, isMobile, section = null }) {
  const rootRef = useRef(null);
  useLayoutEffect(() => {
    if (!section || !rootRef.current) return;
    const el = rootRef.current.querySelector(`[data-section="${section}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
  }, [section]);

  return html`<div class="settings" data-testid="settings" ref=${rootRef}>
    <${PaceSection} settings=${ws.settings} />
    <${SyncSection} />
    <${DataSection} ws=${ws} />
    <${AppearanceSection} settings=${ws.settings} isMobile=${isMobile} />
    <${HelpSection} isMobile=${isMobile} />
  </div>`;
}

function Section({ id, title, children }) {
  return html`<section class="settings-section" data-section=${id} id=${`settings-${id}`}>
    <h3>${title}</h3>
    ${children}
  </section>`;
}

// ---------------------------------------------------------------------------
// Pace

/** Number input committed on every valid keystroke and clamped to its range on blur. */
function NumberField({ id, label, testid, value, range, step = 1, unit, onCommit }) {
  const [draft, setDraft] = useDraft(String(value));
  const onInput = (e) => {
    const text = e.target.value;
    setDraft(text);
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n)) onCommit(n);
  };
  const onBlur = () => {
    const n = Number(draft);
    const next = draft.trim() !== '' && Number.isFinite(n) ? clamp(n, range) : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return html`<div class="field">
    <label for=${id}>${label}</label>
    <div class="input-unit">
      <input id=${id} class="input" type="number" inputmode="decimal" data-testid=${testid} value=${draft} min=${range[0]} max=${range[1]} step=${step}
        onInput=${onInput} onBlur=${onBlur} />
      ${unit ? html`<span class="unit">${unit}</span>` : null}
    </div>
  </div>`;
}

function PaceSection({ settings }) {
  const { store } = useUi();
  const commit = (patch) => store.actions.updateSettings(patch);
  const [target, setTarget] = useDraft(formatDuration(settings.targetSec));
  const onTargetInput = (e) => {
    setTarget(e.target.value);
    const sec = parseDuration(e.target.value);
    if (sec !== null && sec > 0) commit({ targetSec: sec });
  };
  const onTargetBlur = () => {
    const sec = parseDuration(target);
    const next = sec !== null && sec > 0 ? clamp(sec, PACE_RANGES.targetSec) : settings.targetSec;
    setTarget(formatDuration(next));
    if (next !== settings.targetSec) commit({ targetSec: next });
    store.breakCoalescing();
  };
  const wpm = clamp(settings.wpm, PACE_RANGES.wpm);
  const exampleWords = Math.round((wpm * settings.targetSec) / 60);

  return html`<${Section} id="pace" title="Pace">
    <div class="field-row">
      <${NumberField} id="wpm" label="Words per minute" testid="wpm-input" value=${settings.wpm} range=${PACE_RANGES.wpm} unit="wpm"
        onCommit=${(n) => commit({ wpm: n })} />
      <${NumberField} id="pause" label="Pause per joke" testid="pause-input" value=${settings.pauseSec} range=${PACE_RANGES.pauseSec} step=${0.5} unit="s"
        onCommit=${(n) => commit({ pauseSec: n })} />
      <div class="field">
        <label for="target">Target length</label>
        <input id="target" class="input" type="text" inputmode="numeric" data-testid="target-input" placeholder="5:00" value=${target}
          onInput=${onTargetInput} onBlur=${onTargetBlur} />
      </div>
    </div>
    <p class="hint">${exampleWords} words ≈ ${formatDuration(settings.targetSec)} at ${wpm} wpm, plus ${settings.pauseSec} s of laughs per joke.</p>
  <//>`;
}

// ---------------------------------------------------------------------------
// Sync

function SyncSection() {
  const { syncManager, toaster, confirm } = useUi();
  const status = useSyncStatus(syncManager);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const connected = status.state !== 'off';

  const connect = async (e) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setConnectError(null);
    try {
      await syncManager.connect(token);
      setToken('');
      toaster.show({ message: `Connected as ${syncManager.getStatus().login || 'GitHub user'}` });
    } catch (err) {
      setConnectError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const replaceRemote = async () => {
    const first = await confirm({
      title: 'Replace the remote data?',
      message: 'The gist will be overwritten with this device’s data. Other devices pick it up on their next sync.',
      confirmLabel: 'Continue',
      danger: true,
    });
    if (!first) return;
    const second = await confirm({ title: 'Really overwrite the gist?', message: 'This cannot be undone.', confirmLabel: 'Replace remote', danger: true });
    if (!second) return;
    try {
      await syncManager.replaceRemote();
      toaster.show({ message: 'Remote data replaced.' });
    } catch (err) {
      toaster.show({ message: err?.message || 'Replacing the remote data failed.', persistent: true });
    }
  };

  let statusText;
  switch (status.state) {
    case 'off': statusText = 'Not connected.'; break;
    case 'syncing': statusText = 'Syncing…'; break;
    case 'offline': statusText = 'Offline — will sync when the connection is back.'; break;
    case 'error': statusText = status.error || 'Sync failed.'; break;
    default: statusText = status.lastSyncAt ? `Last synced ${relativeTime(status.lastSyncAt)}.` : 'Connected.';
  }

  return html`<${Section} id="sync" title="Sync">
    <p class="hint">Keep desktop and iPhone in step through a secret GitHub Gist in your account. Paste a <em>classic</em> personal access
      token with only the <strong>gist</strong> scope once per device; the app finds or creates the gist itself.${' '}
      <a href=${TOKEN_URL} target="_blank" rel="noopener noreferrer">Create a token on GitHub ↗</a></p>
    ${connected
      ? html`<div class="sync-connected">
          <div class="sync-line">Connected as <strong>${status.login || 'GitHub user'}</strong>
            ${status.gistId ? html` · <a href=${`https://gist.github.com/${encodeURIComponent(status.gistId)}`} target="_blank" rel="noopener noreferrer">open gist ↗</a>` : null}
          </div>
          <div class="sync-line sync-status ${status.state}" data-testid="sync-status" data-state=${status.state}>${statusText}</div>
          <div class="btn-row">
            <button type="button" class="btn btn-primary" data-testid="sync-now" disabled=${status.state === 'syncing'} onClick=${() => syncManager.syncNow()}>Sync now</button>
            <button type="button" class="btn" data-testid="disconnect-button" onClick=${() => syncManager.disconnect()}>Disconnect</button>
            ${status.errorKind === 'other'
              ? html`<button type="button" class="btn btn-danger-ghost" data-testid="replace-remote" onClick=${replaceRemote}>Replace remote with this device’s data</button>`
              : null}
          </div>
        </div>`
      : html`<form class="sync-form" onSubmit=${connect}>
          <div class="field">
            <label for="token">Personal access token</label>
            <input id="token" class="input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" data-testid="token-input"
              placeholder="ghp_…" value=${token} onInput=${(e) => setToken(e.target.value)} />
          </div>
          <div class="btn-row">
            <button type="submit" class="btn btn-primary" data-testid="connect-button" disabled=${busy || token.trim() === ''}>${busy ? 'Connecting…' : 'Connect'}</button>
          </div>
          <div class="sync-line sync-status ${connectError ? 'error' : 'off'}" data-testid="sync-status" data-state=${status.state}>${connectError || statusText}</div>
        </form>`}
    <p class="hint small">Your token is stored only on this device.</p>
  <//>`;
}

// ---------------------------------------------------------------------------
// Data

function DataSection({ ws }) {
  const { store, syncManager, toaster, confirm } = useUi();
  const [pending, setPending] = useState(null); // { name, workspace } parsed from the chosen file
  const fileRef = useRef(null);

  const exportJson = async () => {
    const stamp = nowIso().slice(0, 10);
    try {
      await downloadJson(`standup-set-builder-${stamp}.json`, serializeExport(store.get()));
    } catch (err) {
      toaster.show({ message: `Export failed: ${err?.message || err}`, persistent: true });
    }
  };

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      setPending({ name: file.name, workspace: parseImport(text) });
    } catch (err) {
      setPending(null);
      toaster.show({ message: err?.message || 'The file could not be read.', persistent: true });
    }
  };

  const clearPending = () => {
    setPending(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const importMerge = async () => {
    if (!pending) return;
    const ok = await confirm({
      title: `Merge “${pending.name}”?`,
      message: 'Versions from the file are added to yours; a version edited on both sides is kept twice (one as a conflict copy).',
      confirmLabel: 'Merge',
    });
    if (!ok) return;
    const result = merge(store.get(), pending.workspace, { synced: {} });
    store.replace(result.workspace, { source: 'import' });
    for (const name of result.conflictCopies) toaster.show({ message: `Kept a conflict copy: ${name}`, persistent: true });
    toaster.show({ message: 'Merged.' });
    clearPending();
  };

  const importReplace = async () => {
    if (!pending) return;
    const ok = await confirm({
      title: `Replace everything with “${pending.name}”?`,
      message: 'Replaces the data on all synced devices. Your current versions are deleted (undo is reset).',
      confirmLabel: 'Replace',
      danger: true,
    });
    if (!ok) return;
    const now = nowIso();
    const current = store.get();
    const next = normalize(structuredClone(pending.workspace));
    for (const v of next.versions) v.updatedAt = now;
    next.updatedAt = now;
    const tombstones = { ...next.tombstones };
    for (const [id, at] of Object.entries(current.tombstones)) if (!(id in tombstones) || at > tombstones[id]) tombstones[id] = at;
    const imported = new Set(next.versions.map((v) => v.id));
    for (const v of current.versions) if (!imported.has(v.id)) tombstones[v.id] = now;
    next.tombstones = tombstones;
    store.replace(next, { source: 'import' });
    toaster.show({ message: 'Data replaced.' });
    clearPending();
  };

  const resetAll = async () => {
    const first = await confirm({
      title: 'Reset all data?',
      message: 'This device only; your gist and other devices are not changed. Sync will be disconnected.',
      confirmLabel: 'Continue',
      danger: true,
    });
    if (!first) return;
    const second = await confirm({ title: 'Really delete every version on this device?', message: 'This cannot be undone.', confirmLabel: 'Reset all data', danger: true });
    if (!second) return;
    syncManager.disconnect();
    try {
      localStorage.removeItem(SYNC_KEY);
    } catch {
      // storage unavailable: nothing to remove
    }
    store.replace(createWorkspace());
    toaster.show({ message: 'All data on this device was reset.' });
  };

  const jokes = ws.versions.reduce((n, v) => n + v.topics.reduce((m, t) => m + t.jokes.length, 0), 0);
  return html`<${Section} id="data" title="Data">
    <p class="hint">${plural(ws.versions.length, 'version')}, ${plural(jokes, 'joke')} on this device. Exports never include your sync token.</p>
    <div class="btn-row">
      <button type="button" class="btn" data-testid="export-button" onClick=${exportJson}>Export JSON</button>
      <label class="btn file-btn">
        Import JSON…
        <input type="file" accept=".json,application/json" data-testid="import-input" ref=${fileRef} onChange=${onFile} />
      </label>
    </div>
    <div class="import-box ${pending ? 'has-file' : ''}">
      <div class="import-name">${pending
        ? html`<strong>${pending.name}</strong> · ${plural(pending.workspace.versions.length, 'version')}`
        : html`<span class="muted">Choose a file, then merge it into your data or replace everything.</span>`}</div>
      <div class="btn-row">
        <button type="button" class="btn" data-testid="import-merge" disabled=${!pending} onClick=${importMerge}>Merge</button>
        <button type="button" class="btn btn-danger-ghost" data-testid="import-replace" disabled=${!pending} onClick=${importReplace}>Replace</button>
        ${pending ? html`<button type="button" class="btn btn-ghost" onClick=${clearPending}>Cancel</button>` : null}
      </div>
    </div>
    <div class="btn-row danger-zone">
      <button type="button" class="btn btn-danger-ghost" data-testid="reset-button" onClick=${resetAll}>Reset all data…</button>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// Appearance

function AppearanceSection({ settings, isMobile }) {
  const { store } = useUi();
  return html`<${Section} id="appearance" title="Appearance">
    <div class="field-row">
      <div class="field">
        <label for="theme">Theme</label>
        <select id="theme" class="input" data-testid="theme-select" value=${settings.theme} onChange=${(e) => store.actions.updateSettings({ theme: e.target.value })}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div class="field">
        <label for="colwidth">Column width${isMobile ? ' (desktop)' : ''}</label>
        <select id="colwidth" class="input" data-testid="colwidth-select" value=${String(settings.colWidth)} onChange=${(e) => store.actions.updateSettings({ colWidth: Number(e.target.value) })}>
          <option value="320">Narrow · 320 px</option>
          <option value="360">Default · 360 px</option>
          <option value="420">Wide · 420 px</option>
        </select>
      </div>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// Help

function HelpSection({ isMobile }) {
  return html`<${Section} id="help" title="Help">
    <div class="help">
      <h4>Install on iPhone</h4>
      <p>In Safari tap <strong>Share</strong> → <strong>Add to Home Screen</strong>. The installed app opens full screen and works offline.
        It does <strong>not</strong> see data or the sync token entered in the Safari tab: connect Sync in both, or Export JSON in Safari
        and Import in the installed app.</p>
      <h4>Install on desktop</h4>
      <p>Chrome / Edge: the install icon in the address bar. Safari (macOS Sonoma+): File → Add to Dock.</p>
      <h4>Timing</h4>
      <p>A joke's time is its delivered words (the original text, or the alt you picked) at your pace plus the pause per joke.
        “Set manual time…” in a joke's menu overrides the estimate.</p>
      ${isMobile ? null : html`<h4>Keyboard shortcuts</h4>
        <ul class="shortcuts">
          <li><kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Z</kbd> undo · <kbd>Shift</kbd> + <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Z</kbd> or <kbd>Ctrl</kbd> + <kbd>Y</kbd> redo (outside text fields; fields keep native undo)</li>
          <li><kbd>Enter</kbd> in a title moves to the joke text</li>
          <li><kbd>Esc</kbd> closes menus and dialogs</li>
        </ul>`}
    </div>
  <//>`;
}
