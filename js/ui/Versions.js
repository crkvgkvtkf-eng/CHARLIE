// Versions (SPEC §9.6): the top-bar switcher, the Manage dialog (rename inline, duplicate,
// delete, new blank) and the New-version dialog. Switching is an undoable store action.
import { html, useState, useRef, useLayoutEffect } from '../lib.js';
import { activeVersion } from '../model.js';
import { Dialog, Icon, Menu, focusField, plural, relativeTime, useUi } from './common.js';

/** Topic / joke / in-set counts for a version row. */
function countsOf(version) {
  const jokes = version.topics.reduce((n, t) => n + t.jokes.length, 0);
  return `${plural(version.topics.length, 'topic')} · ${plural(jokes, 'joke')} · ${version.set.jokeIds.length} in set`;
}

/** Top-bar button showing the active version's name; opens the versions menu. */
export function VersionSwitcher({ ws, onNew, onManage }) {
  const { store } = useUi();
  const buttonRef = useRef(null);
  const [open, setOpen] = useState(false);
  const current = activeVersion(ws);
  const items = [
    { header: 'Versions' },
    ...ws.versions.map((v) => ({
      label: v.name || 'Untitled',
      testid: 'version-item',
      data: { id: v.id },
      key: v.id,
      checked: v.id === ws.activeVersionId,
      onSelect: () => {
        if (v.id !== ws.activeVersionId) store.actions.switchVersion(v.id);
      },
    })),
    { divider: true },
    { label: 'New version…', testid: 'version-new', onSelect: onNew },
    { label: 'Manage versions…', testid: 'version-manage', onSelect: onManage },
  ];
  return html`<span class="version-switcher-wrap">
    <button type="button" class="version-switcher" data-testid="version-switcher" ref=${buttonRef} onClick=${() => setOpen((isOpen) => !isOpen)}
      aria-haspopup="menu" aria-expanded=${open} title="Switch version">
      <span class="version-name">${current.name || 'Untitled'}</span>
      <${Icon} name="chevronDown" size=${14} />
    </button>
    ${open ? html`<${Menu} anchor=${buttonRef.current} items=${items} label="Versions" onClose=${() => setOpen(false)} />` : null}
  </span>`;
}

/** The Manage versions dialog. */
export function ManageVersionsDialog({ ws, onClose }) {
  const { store, confirm } = useUi();
  const doneRef = useRef(null);
  const only = ws.versions.length === 1;

  const deleteVersion = async (v) => {
    if (only) return;
    const ok = await confirm({
      title: `Delete “${v.name}”?`,
      message: 'The version and its jokes are removed from this device and, on the next sync, from your other devices. You can undo this.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    // The confirm handed focus back to the row's Delete button, which is about to unmount with its
    // row; focus would fall out of this (still open) dialog onto <body>. Done is the stable landing.
    if (doneRef.current) doneRef.current.focus({ preventScroll: true });
    store.actions.deleteVersion(v.id);
  };

  return html`<${Dialog} onClose=${onClose} label="Manage versions" testid="version-dialog" class="dialog-versions">
    <div class="dialog-head">
      <h2 class="dialog-title">Versions</h2>
      <button type="button" class="btn btn-small" onClick=${onClose} autofocus ref=${doneRef}>Done</button>
    </div>
    <ul class="version-list">
      ${ws.versions.map((v) => html`<${VersionRow} key=${v.id} version=${v} active=${v.id === ws.activeVersionId} only=${only}
        onSwitch=${() => store.actions.switchVersion(v.id)}
        onDuplicate=${() => store.actions.addVersion({ fromVersionId: v.id })}
        onDelete=${() => deleteVersion(v)} />`)}
    </ul>
    <div class="dialog-actions start">
      <button type="button" class="btn" data-testid="version-new-blank" onClick=${() => store.actions.addVersion({ fromVersionId: null })}>
        <${Icon} name="plus" size=${14} /> New blank version
      </button>
    </div>
  <//>`;
}

function VersionRow({ version, active, only, onSwitch, onDuplicate, onDelete }) {
  const { store } = useUi();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(version.name);
  const inputRef = useRef(null);
  // The input mounts inside an already-open dialog, where `autofocus` has no effect: focus it in
  // the commit that mounts it (still inside the Rename click's task) and select the name.
  useLayoutEffect(() => {
    if (!editing) return;
    focusField(inputRef.current);
    inputRef.current.select();
  }, [editing]);

  const startRename = () => {
    setName(version.name);
    setEditing(true);
  };
  const onNameInput = (e) => {
    setName(e.target.value);
    store.actions.renameVersion(version.id, e.target.value);
  };
  const finish = () => {
    store.breakCoalescing();
    setEditing(false);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // keep the dialog open
      finish();
    }
  };

  return html`<li class="version-row ${active ? 'active' : ''}" data-testid="version-row" data-id=${version.id}>
    <div class="version-main">
      ${editing
        ? html`<input class="input version-name-input" type="text" value=${name} ref=${inputRef} aria-label="Version name"
            onInput=${onNameInput} onBlur=${finish} onKeyDown=${onKeyDown} />`
        : html`<button type="button" class="version-pick" onClick=${onSwitch} disabled=${active} title=${active ? 'Current version' : 'Switch to this version'}>
            <span class="version-row-name">${version.name || 'Untitled'}</span>
            ${active ? html`<span class="tag">current</span>` : null}
          </button>`}
      <div class="version-sub">${countsOf(version)} · edited ${relativeTime(version.updatedAt)}</div>
    </div>
    <div class="version-actions">
      <button type="button" class="btn btn-small" data-testid="version-rename" onClick=${startRename}>Rename</button>
      <button type="button" class="btn btn-small" data-testid="version-duplicate" onClick=${onDuplicate}>Duplicate</button>
      <button type="button" class="btn btn-small btn-danger-ghost" data-testid="version-delete" onClick=${onDelete} disabled=${only}
        title=${only ? 'The only version cannot be deleted' : 'Delete this version'}>Delete</button>
    </div>
  </li>`;
}

/** The New version dialog: name + "start from current / blank". */
export function NewVersionDialog({ ws, onClose }) {
  const { store } = useUi();
  const current = activeVersion(ws);
  const blankDefault = `Set v${ws.versions.length + 1}`;
  const copyDefault = `${current.name} copy`;
  const [from, setFrom] = useState('current');
  const [name, setName] = useState(copyDefault);
  const [touched, setTouched] = useState(false);

  const onFromChange = (e) => {
    setFrom(e.target.value);
    if (!touched) setName(e.target.value === 'blank' ? blankDefault : copyDefault);
  };
  const create = (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    store.actions.addVersion({ name: trimmed || undefined, fromVersionId: from === 'blank' ? null : ws.activeVersionId });
    onClose();
  };

  return html`<${Dialog} onClose=${onClose} label="New version" testid="new-version-dialog" class="dialog-small">
    <form class="dialog-form" onSubmit=${create}>
      <h2 class="dialog-title">New version</h2>
      <div class="field">
        <label for="new-version-name">Name</label>
        <input id="new-version-name" class="input" type="text" data-testid="new-version-name" value=${name} autofocus
          onInput=${(e) => { setName(e.target.value); setTouched(true); }} />
      </div>
      <div class="field">
        <label for="new-version-from">Start from</label>
        <select id="new-version-from" class="input" data-testid="new-version-from" value=${from} onChange=${onFromChange}>
          <option value="current">Current version (${current.name})</option>
          <option value="blank">Blank</option>
        </select>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button type="submit" class="btn btn-primary" data-testid="new-version-create">Create</button>
      </div>
    </form>
  <//>`;
}
