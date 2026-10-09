// localStorage persistence plus export/import helpers (SPEC §6).
// Imports cleanly in Node: nothing here touches the DOM until downloadJson is called.
import { nowIso } from './ids.js';
import { createWorkspace, normalize } from './model.js';

export const STORAGE_KEY = 'ssb.workspace.v1';
export const SYNC_KEY = 'ssb.sync.v1';
export const EXPORT_APP = 'standup-set-builder';
const CORRUPT_KEY_PREFIX = 'ssb.workspace.corrupt.';

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** Parse the stored workspace; throws when the text is not a workspace object. */
function parseWorkspace(raw) {
  const parsed = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error('Stored workspace is not an object');
  return normalize(parsed);
}

/**
 * Load and normalize the saved workspace. Missing → a fresh workspace. Unreadable (corrupt JSON,
 * non-object, normalize throwing) → the raw text is copied to `ssb.workspace.corrupt.<ts>` so it
 * can still be recovered by hand, and a fresh workspace is returned.
 */
export function loadWorkspace(storage = globalThis.localStorage) {
  let raw = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return createWorkspace(); // storage disabled: behave like a first run
  }
  if (raw === null || raw === undefined) return createWorkspace();
  try {
    return parseWorkspace(raw);
  } catch {
    try {
      storage.setItem(CORRUPT_KEY_PREFIX + nowIso(), String(raw));
    } catch {
      // Nothing more we can do; the corrupt text stays under STORAGE_KEY until the next save.
    }
    return createWorkspace();
  }
}

/** Persist the workspace. Returns false instead of throwing (quota, private mode, storage disabled). */
export function saveWorkspace(ws, storage = globalThis.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(ws));
    return true;
  } catch {
    return false;
  }
}

/** Pretty export envelope. Only the workspace goes in; sync config (token) is never part of it. */
export function serializeExport(ws) {
  return JSON.stringify({ app: EXPORT_APP, exportedAt: nowIso(), workspace: ws }, null, 2);
}

/** Parse an export envelope or a bare workspace into a normalized workspace. Throws with a readable message. */
export function parseImport(text) {
  let parsed;
  try {
    parsed = JSON.parse(typeof text === 'string' ? text : String(text ?? ''));
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  const candidate = isObject(parsed) && isObject(parsed.workspace) ? parsed.workspace : parsed;
  if (!isObject(candidate) || !Array.isArray(candidate.versions)) {
    throw new Error('The file is not a Stand-Up Set Builder export (no versions found).');
  }
  try {
    return normalize(candidate);
  } catch (err) {
    throw new Error(`The file could not be read: ${err?.message || err}`);
  }
}

function isTouchDevice(nav) {
  return (nav?.maxTouchPoints ?? 0) > 0 || (typeof window !== 'undefined' && 'ontouchstart' in window);
}

/**
 * Hand a JSON text to the user as a file. On touch devices (iOS) the share sheet is preferred when
 * the browser can share files; otherwise a Blob download link is clicked.
 */
export async function downloadJson(filename, text) {
  const nav = globalThis.navigator;
  const type = 'application/json';
  if (isTouchDevice(nav) && typeof File === 'function' && typeof nav?.canShare === 'function') {
    const file = new File([text], filename, { type });
    if (nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: filename });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return; // user dismissed the share sheet
        // Any other failure falls through to the plain download.
      }
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
