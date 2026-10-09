# Stand-Up Set Builder — Specification (v2, after review)

A flow-chart style app for writing a stand-up set. The writer creates **Topic** cards,
**Joke** cards under topics, and **Alt** (alternative) cards under jokes; selects jokes
into a **Set**; sees a running time estimate at a stand-up delivery pace; moves cards
around; undoes; keeps named **Versions**; and syncs across desktop and iPhone.

This document is the contract between modules. Module boundaries and function
signatures here are fixed; implementations may add internal helpers freely.
Where this spec says "stable JSON" it means `JSON.stringify` with object keys sorted
recursively (`stableJson(x)` exported from `js/model.js`).

---

## 1. Product decisions (final)

| Decision | Choice |
|---|---|
| Platform | One Progressive Web App (PWA). Desktop browser + iPhone Safari "Add to Home Screen". Works offline. |
| Hosting | GitHub Pages, "Deploy from a branch", root folder. Served under a sub-path (`https://<user>.github.io/CHARLIE/`), so **all URLs are relative** (`./`), never absolute (`/`). No `<base>` element. |
| Sync | Private GitHub Gist, token pasted once per device. Local-first: everything works without sync. Export/Import JSON always available. |
| Pace | Default 140 words per minute + 2 s laugh pause per joke. Both adjustable. Per-joke time override. Target length default 5:00. |
| Tech | No build step. Plain ES modules. Preact + htm vendored in `vendor/` (import via `js/lib.js`). CSS in `css/app.css`. No other runtime dependencies. |
| Tests | Unit: `node --test tests/unit/`. E2E: `@playwright/test` with `desktop` (Chromium) and `iphone` (WebKit, iPhone 14) projects. E2E runs against `http://127.0.0.1:4173/CHARLIE/` (the static server mounts the repo under `/CHARLIE/` to mirror GitHub Pages and 404s everything else). |
| Browsers | iOS Safari 16.4+, current Chrome/Safari/Firefox/Edge desktop. |

## 2. File layout

```
index.html                 app shell (loads css/app.css, js/app.js as module, registers sw.js); inline boot-failure fallback
manifest.webmanifest       PWA manifest: name, short_name, id "./", start_url "./", scope "./", display standalone, colors, icons 192 + 512 (any) + 512 (maskable)
sw.js                      service worker: cache-first same-origin app shell, versioned cache, SKIP_WAITING message
icons/icon.svg             source icon; icons/icon-192.png, icon-512.png, apple-touch-icon.png (180)   [exist]
css/app.css                all styles; CSS variables; light + dark; desktop + mobile layouts
js/lib.js                  re-exports Preact/htm   [exists — do not change]
js/ids.js                  newId(), nowIso(), setClock(fn|null), setIdFactory(fn|null)   [exists]
js/model.js                pure workspace data model + mutations + normalize + stableJson (no DOM, no storage)
js/timing.js               pure timing math
js/undo.js                 pure history stack
js/storage.js              localStorage persistence, export/import helpers, validation
js/sync.js                 GitHub Gist client + pure merge() + runSync()
js/store.js                state container: wraps model mutations with undo + persistence + subscribers
js/syncManager.js          auto-sync scheduler + status (uses sync.js + store.js)
js/app.js                  boot: load, create store, render <App/>, keyboard shortcuts, SW registration + update flow, visualViewport handling, flush on pagehide
js/ui/dnd.js               pointer-based drag & drop controller (mouse + touch), no framework coupling
js/ui/App.js               layout shell: top bar, board, set panel/tab, More view, dialogs, toasts, responsive switch
js/ui/Board.js             topics → jokes → alts flow-chart board (+ card components); owns per-device collapsed state
js/ui/SetPanel.js          ordered set list, reorder, per-joke times, totals, target bar
js/ui/Versions.js          version switcher + manage dialog + new-version dialog
js/ui/Settings.js          settings sections: Pace, Sync, Data (export/import/reset), Appearance, Help — used as a dialog (desktop) and as the More view (mobile)
js/ui/common.js            Dialog (native <dialog>), Menu, Toast, IconButton, AutoTextarea, TimeChip, Confirm/Prompt helpers
tests/unit/*.test.js       node --test
tests/e2e/*.spec.js        playwright
tests/e2e/fakeGithub.js    in-memory fake of the GitHub gist API for page.route (shared by sync specs)
tests/serve.mjs            static server: `node tests/serve.mjs 4173 --base /CHARLIE/`   [exists]
README.md                  setup: enable Pages, create token, install on iPhone, run tests   [exists; update as needed]
docs/SPEC.md               this file
```

## 3. Data model (`js/model.js`)

All timestamps are ISO-8601 UTC strings (`nowIso()`); compared as strings.
All ids are opaque strings from `newId()`. Ids are unique across the whole workspace
(duplication and conflict copies always remap).

```js
Workspace {
  schemaVersion: 1,
  id: string,
  settings: Settings,
  settingsUpdatedAt: iso,
  activeVersionId: string,
  versions: Version[],              // at least one, ordered by (createdAt, id)
  tombstones: { [versionId]: iso }, // deleted version id -> deletion time (for sync merge)
  updatedAt: iso,
}
Settings { wpm: number (140), pauseSec: number (2), targetSec: number (300), theme: 'system'|'light'|'dark', colWidth: 320|360|420 (360) }
Version {
  id, name: string, createdAt: iso, updatedAt: iso,
  topics: Topic[],                  // display order left→right
  set: { jokeIds: string[], updatedAt: iso },   // THE source of truth for "in set" + order
}
Topic { id, title: string, color: string|null, jokes: Joke[] }   // jokes in display order. NO ui state here (collapsed is per-device, see §9.3)
Joke  { id, title: string, text: string, alts: Alt[], activeAltId: string|null, overrideSec: number|null, notes: string }
Alt   { id, text: string }
```

Rules:
- `title` is a short name (optional, may be ''). `text` is the joke as spoken; timing uses it.
- `activeAltId` = the alt whose text is delivered in the set instead of the joke's own text; `null` = joke's own text. `deliveredText(joke)` returns `joke.text` when `activeAltId` is null or not found among `joke.alts`.
- "In set" is derived: `version.set.jokeIds.includes(joke.id)`. Removing a joke/topic removes its ids from the set. `jokeIds` never contains unknown or duplicate ids (normalize on load).
- `findTopic/findJoke/findAlt` and every topic/joke/alt/set mutation operate on `activeVersion(ws)` only; an id that is not in the active version throws `Error`.
- Every mutation that changes a version sets `version.updatedAt = nowIso()` and `workspace.updatedAt = nowIso()`; a set change also sets `set.updatedAt`. Settings changes set `settingsUpdatedAt` and `updatedAt`.
- A workspace always has ≥1 version. Deleting the last version throws `Error('Cannot delete the only version')`.
- Every `index`/`toIndex` is a position in the target list AFTER the moved item has been removed from its source (`list.splice(idx, 0, item)` after removal), clamped to `[0, list.length]`; `undefined` ⇒ append. Unknown ids throw `Error`. `moveInSet` throws `Error('Joke not in set')` when the joke is absent. `addToSet` is a no-op when the joke is already present, even if an index is given. `moveAlt` to a different joke sets the source joke's `activeAltId` to `null` if it referenced the moved alt. `deleteVersion` of the active version activates the remaining version with the greatest `createdAt`. `addVersion({ fromVersionId: null })` without a name uses `"Set v<N>"`, N = versions.length + 1; with `fromVersionId` and no name uses `"<from name> copy"`.

### 3.1 Exports (mutations mutate the passed `ws` in place)

```js
export function stableJson(value) → string
export function createWorkspace({ name = 'Set v1' } = {}) → Workspace     // one empty version, default settings
export function createVersion({ name, from = null }) → Version            // from: Version to deep-copy WITH FRESH IDS for every topic/joke/alt, remapping set.jokeIds and activeAltId; addVersion delegates to this
export function normalize(ws) → ws         // see 3.2
export function activeVersion(ws) → Version
export function findTopic(ws, topicId) → { version, topic, index } | null
export function findJoke(ws, jokeId)   → { version, topic, topicIndex, joke, index } | null
export function findAlt(ws, altId)     → { version, topic, joke, alt, index } | null
export function deliveredText(joke) → string

// topics
export function addTopic(ws, { title = '', color = null } = {}, index = undefined) → topicId
export function updateTopic(ws, topicId, patch) → void      // patch ⊆ {title,color}
export function removeTopic(ws, topicId) → void              // also removes its jokes from set
export function moveTopic(ws, topicId, toIndex) → void
// jokes
export function addJoke(ws, topicId, { title = '', text = '' } = {}, index = undefined) → jokeId
export function updateJoke(ws, jokeId, patch) → void         // patch ⊆ {title,text,notes,overrideSec,activeAltId}
export function removeJoke(ws, jokeId) → void
export function duplicateJoke(ws, jokeId) → newJokeId        // copy with fresh ids (alts too), inserted right after the source, not in set
export function moveJoke(ws, jokeId, toTopicId, toIndex) → void
// alts
export function addAlt(ws, jokeId, { text = '' } = {}, index = undefined) → altId
export function updateAlt(ws, altId, patch) → void           // patch ⊆ {text}
export function removeAlt(ws, altId) → void                  // resets activeAltId if it pointed here
export function moveAlt(ws, altId, toJokeId, toIndex) → void
export function setActiveAlt(ws, jokeId, altId | null) → void   // altId must belong to the joke
export function promoteAlt(ws, altId) → void                 // swap alt.text with joke.text; activeAltId → null
// set
export function addToSet(ws, jokeId, index = undefined) → void
export function removeFromSet(ws, jokeId) → void
export function toggleInSet(ws, jokeId) → boolean               // returns new inSet
export function moveInSet(ws, jokeId, toIndex) → void
export function isInSet(ws, jokeId) → boolean
// versions
export function addVersion(ws, { name, fromVersionId = ws.activeVersionId } = {}) → versionId   // fromVersionId=null → blank; new version becomes active
export function renameVersion(ws, versionId, name) → void
export function deleteVersion(ws, versionId) → void          // adds tombstone[id] = now
export function switchVersion(ws, versionId) → void          // sets activeVersionId + ws.updatedAt only (does not touch version.updatedAt)
// settings
export function updateSettings(ws, patch) → void             // validates: numeric fields must be finite numbers (throws otherwise); does NOT clamp (clamping is normalize's job, so typing "140" digit by digit works)
```

### 3.2 `normalize(ws)`
Mutates and returns `ws`; idempotent; never deletes a version; never throws for an object input
(callers treat a throw — e.g. non-object input — as corrupt data). It:
- sets `schemaVersion = 1`, `id ||= newId()`;
- `settings` = defaults overlaid with finite `Number()` values clamped (wpm 60–300, pauseSec 0–30, targetSec 1–36000), `theme` ∉ {system,light,dark} → `'system'`, `colWidth` ∉ {320,360,420} → 360;
- missing/invalid ISO timestamps → `'1970-01-01T00:00:00.000Z'`;
- `tombstones` → object keeping only string values;
- `versions` → array (non-objects dropped); duplicate version ids keep the later `updatedAt`;
- per version: `name = String(name ?? 'Untitled')`, `topics` array, `set = { jokeIds, updatedAt }` with `jokeIds` deduplicated (first occurrence) and filtered to joke ids of THIS version;
- per topic: `title` string, `color` string|null, `jokes` array; a stray `collapsed` field is deleted;
- per joke: `title/text/notes` strings, `alts` array of `{id, text}`, `overrideSec` finite number ≥ 0 else `null`, `activeAltId` must be one of its alts else `null`;
- a duplicate topic/joke/alt id anywhere in the workspace gets a fresh id (second occurrence);
- versions sorted by `(createdAt, id)`; if empty → push `createVersion({ name: 'Set v1' })`; invalid `activeVersionId` → `versions[0].id`.

## 4. Timing (`js/timing.js`)

```js
export function countWords(text) → number   // tokens split on whitespace that contain ≥1 letter or digit (/[\p{L}\p{N}]/u). "—" alone is not a word. "don't" = 1. "5" = 1.
export function jokeSeconds(joke, settings) → number   // overrideSec ?? (countWords(deliveredText(joke)) / wpm * 60 + pauseSec). Never negative. Joke with 0 words and no override = pauseSec.
export function setEstimate(ws) → { totalSec, words, items: [{ jokeId, title, snippet, topicTitle, seconds, words, overridden }], targetSec, deltaSec, ratio }
   // items follow set.jokeIds order; snippet = first 60 chars of deliveredText, whitespace collapsed; title = joke.title || snippet || 'Untitled joke'
export function topicEstimate(ws, topicId) → { inSet: number, total: number, seconds: number }  // jokes of this topic that are in the set
export function formatDuration(sec) → 'm:ss' (round to nearest second; ≥ 1 h shows 'h:mm:ss')
export function formatDelta(sec) → '+0:12' | '−0:12' | '0:00'   (U+2212 minus)
export function parseDuration(text) → number | null   // '5:00' → 300, '90' → 90, '1:02:03' → 3723, invalid → null
```

## 5. Undo (`js/undo.js`)

```js
export function createHistory({ limit = 200, coalesceMs = 1000, now = Date.now } = {}) → history
history.push(before, { coalesceKey = null } = {})
history.undo(current) → previousSnapshot | null
history.redo(current) → nextSnapshot | null
history.canUndo() / canRedo() → boolean
history.breakCoalescing()
history.clear()
```
Semantics: `past` holds entries `{ state: before, key, closed, at }` (state BEFORE each change); `future` holds
states to redo. `push(before, { coalesceKey })`: if `coalesceKey != null`, `past` is non-empty, the top
entry's `key === coalesceKey`, that entry is not `closed`, and `now() - top.at <= coalesceMs`, then do
nothing except clear `future` and refresh `top.at = now()`. Otherwise push `{ state: before, key: coalesceKey, closed: false, at: now() }`,
clear `future`, and drop the oldest entry while `past.length > limit`. The key lives on the entry, never in
a side variable. `breakCoalescing()` marks the top entry closed. `undo()`, `redo()` and `clear()` also close
the top entry (restoring a state must start a new coalescing run). `undo(current)` pops `past`, pushes
`current` onto `future`, returns the popped state; `redo(current)` mirrors it (pushing `current` to `past` as a closed entry).

## 6. Storage (`js/storage.js`)

```js
export const STORAGE_KEY = 'ssb.workspace.v1'
export const SYNC_KEY = 'ssb.sync.v1'
export function loadWorkspace(storage = localStorage) → Workspace       // parse + normalize; missing → createWorkspace(); corrupt JSON / non-object / normalize throw → copy raw to `ssb.workspace.corrupt.<ts>` and return createWorkspace()
export function saveWorkspace(ws, storage = localStorage) → boolean     // JSON.stringify + setItem in try/catch; false on failure (quota, private mode, disabled)
export function serializeExport(ws) → string                            // pretty JSON `{ app: 'standup-set-builder', exportedAt, workspace }`; NEVER includes sync config
export function parseImport(text) → Workspace                           // accepts export envelope OR bare workspace; validates shape (object with versions array); normalize; throws Error with a human message
export async function downloadJson(filename, text) → void               // on iOS/touch prefer navigator.share({ files: [File] }) when navigator.canShare says so; else Blob + <a download>
```
Local save is debounced in the store (150 ms) and flushed synchronously on `pagehide` and
`visibilitychange→hidden` (listeners registered by `app.js`, calling `store.flush()`). On boot `app.js`
calls `navigator.storage?.persist?.()` and ignores the result. A failed save shows a persistent toast
"Couldn't save on this device (storage full?) — export your data" with an Export action, at most once per minute.

## 7. Sync (`js/sync.js`)

Transport: GitHub REST API, `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28`. Token: a **classic** personal access token with only the `gist`
scope (fine-grained tokens cannot access the Gist API). Gist is **secret** (`public: false`),
description `Stand-Up Set Builder data`, single file `standup-set-builder.json` whose content is the
export envelope from §6.

```js
export const GIST_FILENAME = 'standup-set-builder.json'
export class SyncError extends Error   // { status, kind: 'auth'|'network'|'notfound'|'ratelimit'|'other', retryAfterMs?: number }
export function createClient({ token, fetch = globalThis.fetch, baseUrl = 'https://api.github.com' }) → {
  whoami()                         → { login, scopes: string[] }   // GET /user; scopes parsed from `X-OAuth-Scopes` (comma-separated; missing → [])
  findGist()                       → { id, updated_at } | null     // GET /gists?per_page=100&page=N, N=1..5, stop at an empty/short page; first gist whose files contain GIST_FILENAME
  createGist(contentString)        → { id, updated_at }
  readGist(id)                     → { content: string, updated_at }   // if file.truncated: fetch file.raw_url WITHOUT Authorization and with cache:'no-store'
  writeGist(id, contentString)     → { updated_at }
}
```
Error mapping: fetch rejection/TypeError → `network`; 401 → `auth`; 403/429 with `x-ratelimit-remaining: 0`
or `retry-after` → `ratelimit` (retryAfterMs from `retry-after` seconds or `x-ratelimit-reset` epoch, min 60 s);
other 403 → `auth`; 404 → `notfound`; anything else → `other`. On `/gists*` endpoints a 403/404 means the token
cannot use gists: message "This token can't access gists. Create a classic token with the gist scope."

```js
export function merge(local, remote, { synced = {} } = {}) → { workspace, localChanged, remoteChanged, conflictCopies: string[] }
export async function runSync({ client, workspace, gistId = null, synced = {} }) → { workspace, gistId, pushed, pulled, localChanged, remoteChanged, conflictCopies, remoteUpdatedAt, synced }
export function syncedMapOf(ws) → { [versionId]: updatedAt }
```

### 7.1 Merge rules (pure, deterministic, no clock, no random ids; `merge(a,b)` and `merge(b,a)` yield the same version set)
Let `changed(v) := synced[v.id] !== v.updatedAt` (unknown id ⇒ changed). `synced` is this device's record of the
`updatedAt` each version had when it was last reconciled with the gist.
1. Tombstones: union; for the same id keep the later time.
2. Versions: union by id. For an id on both sides keep the one with later `updatedAt`; on equal `updatedAt` with different
   content keep the one whose stable JSON sorts first. Drop any version whose tombstone time is later than its `updatedAt`
   (deletion wins over older edits; an edit after deletion resurrects it).
3. Conflict safety net (symmetric):
   a. Same id on both sides, contents differ (stable JSON of `{ topics, set.jokeIds }`) AND `changed(localV)` AND `changed(remoteV)`:
      both diverged from the common base → keep the rule-2 loser as an extra version. If only one side changed, plain LWW, no copy.
   b. A version dropped by the other side's tombstone (rule 2) is kept as a copy when `changed(v)` is true (edits that never
      reached the deleting device must not die with the deletion).
   c. Copy = deep copy with `id = "<v.id>~conflict~<v.updatedAt>"`, name `"<name> (conflict copy)"`, `createdAt = updatedAt = v.updatedAt`,
      topics/jokes/alts ids remapped deterministically (`"<oldId>~c"`). Deterministic: a retried sync yields the same id and unions cleanly.
      A copy whose id already exists on either side is not created again. `conflictCopies` lists the names created by THIS merge.
4. Settings: later `settingsUpdatedAt` wins (tie → local).
5. `activeVersionId`: local's if still present, else remote's if present, else first version.
6. Order versions by `(createdAt, id)`. `updatedAt` = max of both. `id`/`schemaVersion` from local.
7. `localChanged` = stable JSON of merged ≠ local; `remoteChanged` = merged ≠ remote.

### 7.2 `runSync` flow
1. If `gistId` null → `findGist()`; if none → `createGist(serializeExport(workspace))` → return `{ pushed: true, pulled: false, synced: syncedMapOf(workspace) }`.
2. `readGist` → `parseImport` (normalize). Corrupt/unparseable remote → throw `SyncError(kind:'other', 'Remote data is unreadable')` (never overwrite it automatically).
   `notfound` on read/write → clear `gistId`, repeat step 1 once within the same run.
3. **Pristine adoption**: if the local workspace is pristine — exactly one version with zero topics and an empty set — and `synced` is empty,
   skip merge and adopt the remote: `workspace = remote`, `localChanged = true`, `remoteChanged = false`, `pulled = true`.
4. Otherwise `merge(local, remote, { synced })`.
5. If `remoteChanged` → `writeGist(serializeExport(merged))`, `pushed = true`. `pulled = localChanged`.
6. Return the merged workspace and `synced = syncedMapOf(mergedWorkspace)` — produced only after the write succeeded (or no write was needed).

### 7.3 Sync manager (`js/syncManager.js`)
```js
export function createSyncManager({ store, loadConfig, saveConfig, createClient = sync.createClient, runSync = sync.runSync, merge = sync.merge, now = Date.now }) → mgr
mgr.getStatus() → { state: 'off'|'idle'|'syncing'|'error'|'offline', lastSyncAt: iso|null, error: string|null, errorKind: string|null, login: string|null, gistId: string|null }
mgr.subscribe(fn) → unsubscribe
mgr.connect(token) → Promise<void>     // whoami(); if scopes non-empty and lacks 'gist' → reject SyncError(auth, gist-scope message) and save nothing; then run a sync with the candidate token; on success save { token, login, gistId, synced } and status idle; any failure → reject and leave config untouched
mgr.disconnect()                       // clears token/login/gistId but KEEPS `synced`; status 'off'
mgr.syncNow() → Promise<void>          // never rejects (errors → status); guarded: one in-flight at a time; a request during flight sets `dirty` and re-runs once after
mgr.scheduleSync()                     // debounce 2500 ms; no-op when off / auth error / offline
mgr.replaceRemote() → Promise<void>    // "Replace remote with this device's data": writeGist(serializeExport(store.get())) directly (creating the gist if needed), then synced = syncedMapOf
mgr.start({ win = globalThis.window, doc = globalThis.document, nav = globalThis.navigator } = {})   // attaches listeners only when the objects exist
mgr.stop()
```
Config (`ssb.sync.v1` in localStorage): `{ token, login, gistId, synced: { [versionId]: updatedAt } }`.
Construction touches no globals; timers use global `setTimeout` so `node:test` mock timers work.

Applying a sync result (inside `syncNow`, after the guards):
```js
const base = store.get();
const r = await runSync({ client, workspace: base, gistId, synced });
let ws = r.workspace, localChanged = r.localChanged;
const latest = store.get();
if (latest !== base) {                                  // user edited during the flight — never discard in-flight edits
  const m = merge(latest, ws, { synced: r.synced });
  ws = m.workspace; localChanged = m.localChanged; dirty = true;   // follow-up run pushes the re-merged state
}
if (localChanged) store.replace(ws, { source: 'sync', resetHistory: false });  // push-only syncs MUST NOT touch the store (undo survives)
saveConfig({ ...cfg, gistId: r.gistId, synced: r.synced });
```
Store changes whose `meta.source === 'sync'` do not schedule a sync. Conflict copies → toast "Kept a conflict copy: <name>" (persistent).

Status rules: `off` = no token. `offline` = `nav.onLine === false` or the last run failed with kind `network`; no automatic
runs while offline; `online` or visibility→visible retries. `auth` errors: status `error` with "GitHub rejected the token —
reconnect in Settings"; `scheduleSync` is a no-op until `connect()` succeeds. `ratelimit`: next automatic run no earlier than
`retryAfterMs` (min 60 s); manual Sync now still allowed. `other` (incl. unreadable remote): status `error` with the message;
Settings › Sync shows a "Replace remote with this device's data" button (double confirm) → `mgr.replaceRemote()`.
Triggers: `start()` → initial `syncNow()` if connected; store change (non-sync source) → `scheduleSync()`;
`online` → `syncNow()`; `visibilitychange→visible` → `syncNow()`; `visibilitychange→hidden` → if a sync is scheduled,
cancel the debounce and call `syncNow()` immediately (best effort).

## 8. Store (`js/store.js`)

```js
export function createStore(initialWorkspace, { persist = () => true, history = createHistory(), onPersistError = console.error, debounceMs = 150, now = nowIso } = {}) → store
store.get() → Workspace                       // current immutable snapshot (never mutate)
store.subscribe(fn: (ws, meta) => void) → unsubscribe     // meta: { source: 'user'|'undo'|'redo'|'sync'|'import'|'replace', label }
store.apply(label, mutator: (draft) => any, { coalesceKey = null } = {}) → any
store.undo() / store.redo() → boolean
store.canUndo() / store.canRedo() → boolean
store.breakCoalescing()
store.replace(ws, { source = 'replace', resetHistory = true } = {})
store.flush() → void                          // runs a pending debounced persist synchronously; no-op if none
store.actions                                 // every model mutation bound: (...args) => store.apply(name, d => model[name](d, ...args), { coalesceKey })
```
- `apply`: `draft = structuredClone(current)`; run mutator; if `stableJson(draft) === stableJson(current)` return the value without
  pushing history, persisting or notifying; else `history.push(current, { coalesceKey })`, set current = draft, schedule persist, notify `{source:'user', label}`.
  If the mutator throws, state is unchanged and the error propagates.
- `undo`/`redo`: the restored snapshot is **stamped** before it becomes current: for every version whose stable JSON differs between the
  current and the restored workspace set `updatedAt = now()` (and `set.updatedAt = now()` if `set.jokeIds` differ); set `settingsUpdatedAt = now()`
  if settings differ; always set `ws.updatedAt = now()`. Tombstones are restored as they were. The history entries themselves are not modified
  (redo still works). Schedule persist; notify with source `'undo'`/`'redo'`.
- `replace`: `normalize(ws)`; if `resetHistory` → `history.clear()`, else `history.push(current)` as a closed entry; persist immediately; notify.
- Persist errors (throw or `false` return) are caught and passed to `onPersistError`; state and notification are unaffected.
- Coalesce keys for text edits: `updateJoke` with a `text` patch → `joke:text:<id>`, `title` → `joke:title:<id>`, `notes` → `joke:notes:<id>`;
  `updateTopic` title → `topic:title:<id>`; `updateAlt` text → `alt:text:<id>`; `renameVersion` → `version:name:<id>`; `updateSettings` → `settings`.
  `breakCoalescing()` is called on blur of any text field and when inserted text contains a newline.

## 9. UI

### 9.1 Responsive layouts
- **Desktop (min-width: 768px)**: top bar; main = board (horizontal scroll, topic columns `--col-w` wide, default 360 px, Settings › Appearance offers 320/360/420) + right sidebar "Set" (340 px, collapsible; collapsed by default when the viewport is < 1100 px; remembered in `ssb.ui.setCollapsed` once toggled). Alt cards indent 12 px (not a second full card inset).
- **Mobile (max-width: 767.98px)**: compact top bar; content = one of three views selected by a bottom tab bar: **Board**, **Set**, **More**.
  - Board: a horizontal flex scroller; each topic column is `flex: 0 0 100%` of the board (never `100vw`), `scroll-snap-align: start`, container `scroll-snap-type: x mandatory`; "+ Topic" is the last page. Current page index is UI state (`activeTopicIndex`), updated from the container's `scroll` events (rAF-throttled, `Math.round(scrollLeft / clientWidth)`) and shown by a pager of pills under the top bar (pills scroll horizontally; tap = `scrollTo({ left: i * clientWidth, behavior: 'smooth' })`). After addTopic / moveTopic / deleteTopic / addVersion / switchVersion on mobile, a layout effect scrolls the board (`behavior: 'instant'`) to the acted-on topic (or the nearest remaining one), and a new topic focuses its title.
  - Set tab label is live: "Set · 4:12" with the delta colour from §9.5 so the running total is visible while ticking jokes on the Board tab.
  - More view = the §9.7 sections rendered inline as a scrolling page (not a sheet), with a "Versions" entry at the top opening the Manage dialog. The More tab shows a red badge while sync status is `error`.
  - Bottom bar respects `env(safe-area-inset-bottom)`.
- iOS specifics: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style=black-translucent` with a **dark top bar in both themes** (white status glyphs stay legible), `apple-touch-icon`, `<meta name="theme-color">` matching the top bar. Safe areas: top bar `padding-top: env(safe-area-inset-top)`; tab bar / toasts / sheets `padding-bottom: env(safe-area-inset-bottom)`; board and lists `padding-left/right: env(safe-area-inset-left/right)`. `html, body { height: 100%; overflow: hidden; overscroll-behavior: none; -webkit-text-size-adjust: 100%; }`; the app root is `position: fixed; inset: 0; height: var(--vvh, 100dvh)`. Inputs ≥16 px font, `-webkit-tap-highlight-color: transparent`, `overscroll-behavior: contain` on every inner scroller.
- Keyboard handling (mobile): `app.js` subscribes to `window.visualViewport` `resize`/`scroll` and sets on `:root` `--vvh: <visualViewport.height>px` and `--kb-inset: max(0, innerHeight − visualViewport.height − visualViewport.offsetTop)px`, and calls `window.scrollTo(0, 0)` whenever `visualViewport.offsetTop > 0`. While `--kb-inset` > 100 px on mobile the bottom tab bar is hidden and the scrolling column gets `padding-bottom: calc(var(--kb-inset) + 16px)`. Toasts and bottom-sheet dialogs sit above `var(--kb-inset)`; sheets use `max-height: calc(var(--vvh) − 24px); overflow: auto`.
- Install nudge: on boot, if not standalone (`navigator.standalone || matchMedia('(display-mode: standalone)').matches` is false) on a touch device AND the workspace has ≥1 joke AND sync is off, show a dismissible banner (remembered in `ssb.ui.installNudgeDismissed`): "Install to your Home Screen or connect Sync. Safari may delete this app's local data after 7 days without a visit, and the installed app starts empty — export here and import there, or connect Sync on both."

### 9.2 Top bar
Desktop: app name ("Set Builder"), version switcher (current version name → menu listing versions, "New version…", "Manage versions…"), Undo / Redo icon buttons (disabled when unavailable; tooltips with shortcut), sync status dot (off=grey, idle=green, syncing=animated, error=red, offline=amber; click → Settings › Sync), Settings gear.
Mobile: version name (tap → versions menu), undo, redo, sync status dot (tap → More › Sync). No overflow menu.

### 9.3 Board (flow chart)
Each topic is a column:
```
┌ Topic card ───────────────┐   grip (desktop only) · editable title · "2/5 in set · 1:10" chip · ⋯ menu
└──────┬────────────────────┘
       ├─ ┌ Joke card ─┐    (connector lines drawn with CSS: vertical spine + horizontal stubs, topic colour tint)
       │  │ [✓ In set] grip title · time chip "0:24 · 56w" · ⋯ │
       │  │ textarea (auto-grow)                              │
       │  │   ( ) Use original                                 │  (only shown when the joke has alts)
       │  │   └─ Alt card: ( ) Use this · textarea · ⋯          │
       │  │   [+ Alt]                                            │
       ├─ ┌ Joke card ─┐
       └─ [+ Joke]
```
- Topic menu: Rename (focuses the title input synchronously), Collapse/Expand jokes, Move left/right, Color (6 presets + none), Delete topic (confirm; shows joke count).
- Collapsed topics are per-device UI state in localStorage `ssb.ui.collapsed` (JSON array of topic ids), owned by Board.js; never in the workspace, undo history or sync.
- Joke card: "In set" checkbox pill (adds to end of set / removes); title input (placeholder "Joke title"); text textarea (placeholder "Write the joke as you'd say it…"); time chip reflects delivered text + override (override shown with a ⏱ marker and tooltip "Manual time"); alts visible by default, a small "▾ 2 alts" toggle collapses them (UI-only state). Menu: Add alt, Set manual time… (prompt m:ss; blank clears), Move to topic… (list), Move up / Move down, Duplicate joke, Delete joke (confirm if text non-empty). Selected (in-set) jokes get an accent left border and a badge with their set position (#3).
- Alt card: radio "Use this in set", textarea, menu: Make this the main joke (promoteAlt), Move to joke… (jokes of the same topic), Move up/down, Delete alt.
- Empty board: centered empty state with "+ Add your first topic".
- Keyboard: Enter in a title input moves focus to the text. Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z (and Ctrl+Y) = undo/redo when focus is NOT in a text field (text fields keep native undo); the toolbar buttons always use app history. Esc closes menus/dialogs.
- Programmatic focus rules (iOS keyboard only appears for focus inside the user-gesture task): focus existing elements synchronously inside the tap/click/keydown handler. For elements that do not exist yet (new topic/joke/alt, dialog inputs) set `focusRequest = { id, field }` in UI state in the same handler and focus from `useLayoutEffect` during the commit that mounts the element; never from `setTimeout`/`requestAnimationFrame`. Dialogs focus their first field via the `autofocus` attribute.
- AutoTextarea (common.js): auto-grow uses the CSS grid replicated-value technique (wrapper `display:grid`; a `::after` pseudo-element mirroring the value via `data-value` and the textarea both in `grid-area: 1/1/2/2`, same font/padding); textarea `overflow: hidden; resize: none`; no JS height measurement.

### 9.4 Drag & drop (`js/ui/dnd.js`)
Pointer-events based (mouse, pen, touch). Every draggable has a grip handle (≥44×44 px on touch) with
`touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none`, and `contextmenu` on a grip is
`preventDefault`ed. On `pointerdown` (primary button only) the controller tries `grip.setPointerCapture(e.pointerId)` inside try/catch
(synthetic events have no active pointer) and ALSO listens for `pointermove`/`pointerup`/`pointercancel` on `window` until the gesture
ends, so capture is an optimisation, never a requirement. Drag starts after 4 px of movement (mouse/pen) or after a 150 ms hold (touch;
`pointerup`/`pointercancel` before 150 ms is a tap). While dragging: `document.body` gets `.is-dragging` (`user-select: none; cursor: grabbing`);
a `position: fixed; pointer-events: none` ghost shows only the card's header row (title + chips), max-height 72 px, width of the source card,
0.85 opacity; the source card gets `.is-dragging` (dimmed). The drop target is found with `document.elementFromPoint(clientX, clientY)`
(→ closest `[data-drop]`), never from `event.target`. `pointercancel`, `Esc`, window `blur` and `visibilitychange→hidden` cancel the drag.
Vertical containers auto-scroll when the pointer is within 40 px of their edge; the horizontal board auto-scrolls on desktop only.
Mobile: while any drag is active the board gets `.is-dragging-board` → `scroll-snap-type: none`; joke/alt drags reorder within the visible
column; to move across topics the user holds the pointer within 40 px of the left/right board edge for 500 ms → the board pages one topic
(instant), at most one page per dwell. Topic-column drag is desktop-only (the topic grip is hidden below the breakpoint; Move left/right + pager are the mobile affordance).

Four drag kinds: `topic` (reorder columns, horizontal; container `[data-drop="topics"]`), `joke` (`[data-drop="jokes"][data-topic-id]`),
`alt` (`[data-drop="alts"][data-joke-id]`), `set` (`[data-drop="set"]`). Insertion index = compare pointer coordinate to midpoints of the
container's child cards (`[data-card]`, excluding the dragged one), vertical for lists, horizontal for topics.
```js
export function createDnd({ onDrop, onStateChange }) → { attach(gripEl, { kind, id, cardEl }), detach(gripEl), destroy() }
// onDrop({ kind, id, containerId, index }); onStateChange({ dragging: boolean, kind })
```
Menus (Move up/down, Move to…) are the keyboard/accessibility fallback and must always exist.

### 9.5 Set panel / Set tab
Header "Set" with count ("6 jokes"). Ordered list: position, grip, title (or snippet), topic name (small), time; tap/click title → reveal the joke
on the board: on desktop scroll horizontally+vertically to it and flash; on mobile switch to the Board tab, scroll the board to the joke's topic
page (`behavior: 'instant'`), then after render `scrollIntoView({ block: 'center' })` on the joke card and flash. The flash is a 1.2 s outline
animation, disabled under `prefers-reduced-motion`. Remove (×) button. Footer: **Total** big (m:ss), words, target (m:ss, editable via Settings),
delta (“+0:12 over” red / “−0:40 under” / “on target” when |delta| ≤ 5 s), progress bar (ratio to target; colour: under 85 % neutral,
85–105 % green, >105 % red). Empty: "Tick 'In set' on a joke to build your set." Set order is independent of board position.

### 9.6 Versions
Switcher in the top bar. Manage dialog: list (name, updated time, counts), Rename (inline), Duplicate, Delete (confirm; refused for the only version),
"New blank version". New version dialog: name input defaulting to `"<current> copy"`, option "Start from: current version / blank".
Switching versions is an undoable action.

### 9.7 Settings (dialog on desktop, More view on mobile)
- **Pace**: Words per minute (number, 60–300, default 140); Pause per joke (seconds, 0–30, default 2); Target length (m:ss, default 5:00). Live example: "700 words ≈ 5:00 at 140 wpm" updates. Values are committed on change; invalid/out-of-range input is clamped on blur.
- **Sync**: one-paragraph explanation, link `https://github.com/settings/tokens/new?scopes=gist&description=Stand-Up%20Set%20Builder`, token input (type=password, autocomplete=off), Connect → "Connected as <login>", gist link (`https://gist.github.com/<id>`), last synced, Sync now, Disconnect. Error text when any; "Replace remote with this device's data" when `errorKind === 'other'`. Note: "Your token is stored only on this device."
- **Data**: Export JSON (download/share; never includes sync config). Import JSON (file input → Replace or Merge → confirm).
  **Merge** = `merge(store.get(), imported, { synced: {} })` applied via `store.replace(result.workspace, { source: 'import' })`; conflict copies toasted.
  **Replace** = `ws = normalize(imported)`; set `updatedAt = now` on every imported version and on ws; copy the current `tombstones` into ws and add `tombstones[id] = now` for every current version id absent from the import; then `store.replace(ws, { source: 'import' })`. The confirm says "Replaces the data on all synced devices."
  **Reset all data** (double confirm) = `store.replace(createWorkspace())` AND `syncManager.disconnect()` + remove `ssb.sync.v1` entirely; the confirm says "This device only; your gist and other devices are not changed. Sync will be disconnected."
- **Appearance**: theme system/light/dark; column width 320/360/420 (desktop).
- **Help**: Install on iPhone: Share → Add to Home Screen. "The installed app does NOT see data or the sync token entered in the Safari tab: connect Sync in both, or Export JSON in Safari and Import in the installed app." Desktop install. Keyboard shortcuts.

### 9.8 Toasts & dialogs
Toasts: bottom-center, above the mobile tab bar, the safe-area inset and `--kb-inset`. Auto-dismiss after 3 s when there is no action, 8 s when
there is one (timer paused while hovered/touched); "Update available · Reload", "Kept a conflict copy: …" and save/sync error toasts persist
until dismissed or acted on. At most 3 toasts stack. Dialogs are native `<dialog>` elements opened with `showModal()` (inert background,
Esc via the `cancel` event, focus trap for free); click on the backdrop (`event.target === dialogEl`) closes. Mobile: full-width sheet from the bottom.

### 9.9 Visual design
Clean, high-contrast, card-based. CSS variables on `:root` (light) and `[data-theme=dark]` / `prefers-color-scheme` (dark); `app.js` sets
`data-theme` from settings. Dark top bar in both themes. Accent colour for in-set state. Topic colours are soft tints applied to the topic
header and connector lines. System font stack. Connector lines 2 px, `var(--line)`. Card radius 10 px, subtle shadow. Minimum tap target 44 px
on mobile. Reduced motion respected.

## 10. Service worker (`sw.js`) and update flow
- `CACHE = 'ssb-v<N>'` (bump N whenever any precached asset changes; a unit test checks the precache list against disk).
- Precache: `./`, `./index.html`, `./manifest.webmanifest`, `./css/app.css`, every `./js/**` module, `./vendor/*.js`, icons. Add each entry individually so one missing file cannot fail the install.
- Fetch: the handler returns immediately (no `respondWith`) for any request that is not a same-origin GET, so api.github.com and
  gist.githubusercontent.com are fetched by the page itself, never cached, and remain interceptable by test tooling. Same-origin GET →
  cache-first, then network (caching OK responses); navigation requests → network first, falling back to cached `./index.html`.
- Activate: delete other `ssb-*` caches, `clients.claim()`. `skipWaiting` on message `{ type: 'SKIP_WAITING' }`.
- Update flow (`js/app.js`): `reg = await navigator.serviceWorker.register('./sw.js', { scope: './' })`. On `reg.updatefound` watch `reg.installing`;
  when its state becomes `installed` AND `navigator.serviceWorker.controller` is non-null, show the persistent toast "Update available · Reload"
  (no toast on first install); also handle `reg.waiting` already set at load. Register ONCE at boot
  `navigator.serviceWorker.addEventListener('controllerchange', () => { if (refreshing) return; refreshing = true; location.reload(); })`.
  The toast action posts `reg.waiting.postMessage({ type: 'SKIP_WAITING' })` and nothing else. Call `reg.update()` on `visibilitychange→visible`
  at most once per hour.

## 11. First run
Empty workspace with one version "Set v1", no topics; board shows the empty state. No sample data.

## 12. Accessibility & robustness
- All icon buttons have `aria-label`. Menus are keyboard navigable (arrow keys, Enter, Esc). Dialog focus trap via `<dialog>`.
- The app never silently loses user text: save on every change (debounced) + flush on pagehide; save failures are surfaced; sync never
  overwrites remote with corrupt data; import validates; in-flight edits survive a sync; conflict copies instead of silent loss.
- Any uncaught error during boot shows a plain-HTML fallback with an "Export my data" button that writes
  `{ app: 'standup-set-builder', exportedAt, localStorage: {…} }` containing every `ssb.*` key EXCEPT `ssb.sync.v1` (it holds the token and is never exported).

## 13. Testing requirements
Unit (`node --test`), with `setClock` installing a strictly increasing fake clock and `setIdFactory` a counter:
- model: every mutation incl. index semantics after removal, clamping, unknown-id throws, duplication id remap (edit copy → original byte-identical),
  normalize cases (dup set ids, NaN settings, stray collapsed, dup ids, empty versions), deliveredText fallback, moveAlt resetting activeAltId.
- timing: word counting edge cases, override, zero-word joke, formatting, parseDuration.
- undo: coalescing by key + idle window (same key 500 ms apart → one entry; 1500 ms apart → two), type/undo/type/undo, redo cleared on push, limit, breakCoalescing.
- storage: corrupt JSON recovery (+ corrupt backup key), import validation, export envelope excludes sync config.
- sync.merge: every rule incl. tombstones, symmetry (`merge(a,b)` vs `merge(b,a)` version sets equal), conflict copies (both changed → copy;
  one changed → no copy; tombstone vs unsynced edit → copy; retry → no duplicate copy; remote clock ahead → no spurious copy; local clock behind → edit not lost).
- runSync with a fake fetch implementing the gist endpoints: first-time create, pristine adoption, pull/push, notfound recovery, unreadable remote, scopes.
- store: apply/undo/redo/replace/persist, no-op apply pushes nothing, undo stamping (updatedAt advances; undone content wins a later merge),
  persist throwing still notifies, flush writes immediately.
- syncManager (mock timers, fake client): debounce, in-flight guard + dirty re-run, store change during an in-flight sync survives, push-only sync leaves canUndo true and does not notify, auth error stops scheduling, ratelimit backoff, pristine adoption on connect.
- sw: read `sw.js`, extract the precache array, assert it equals the sorted set of `./css/**`, `./js/**`, `./vendor/*.js`, icon and manifest paths on disk (+ `./` and `./index.html`).

E2E (Playwright, both projects unless stated), see 13.1: create topic/joke/alt; in-set toggle + total time + live Set tab label (iphone); reorder via menu AND via drag
(desktop `page.mouse`; iphone synthetic touch pointer events); undo/redo via toolbar; versions create/switch/delete; settings wpm change updates total;
export produces JSON; import restores; offline reload after first load (desktop only); two-context sync through the fake GitHub API (second context
adopts the first's data with a single version after Connect; an edit on one appears on the other after Sync now); sub-path smoke test: `navigator.serviceWorker.ready`
scope ends in `/CHARLIE/`, no request during load/interaction/reload targets `127.0.0.1:4173` outside `/CHARLIE/`, `index.html` has no `<base>`.

### 13.1 E2E notes
- Sync tests create contexts with `serviceWorkers: 'block'` (page.route cannot see service-worker traffic) and share one in-memory gist object between
  the route handlers for `https://api.github.com/**` (`tests/e2e/fakeGithub.js`). The fake implements: GET /user → 200 `{login}` with header
  `X-OAuth-Scopes: gist`; GET /gists?per_page=100&page=N → array (empty for N>1) whose items carry `files: { [filename]: {...} }`; POST /gists;
  GET /gists/:id → `{ id, updated_at, files: { [GIST_FILENAME]: { content, truncated: false } } }`; PATCH /gists/:id.
- Touch drag on the iphone project drives the dnd controller with synthetic pointer events: `grip.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 1, isPrimary: true, clientX, clientY, button: 0, buttons: 1, bubbles: true })`,
  `page.waitForTimeout(250)` (>150 ms hold), then `pointermove` events (dispatched on `document`) at the target position and `pointerup`; desktop uses `page.mouse`.
- The offline test runs in the desktop project only (`test.skip(({ browserName }) => browserName !== 'chromium')`): load, `await navigator.serviceWorker.ready`,
  poll `caches.keys()` until the `ssb-v*` cache has all precache entries, then `context.setOffline(true)`, `page.reload()`, assert the board renders.
- Tests that need data seed it through the UI or by setting `localStorage[STORAGE_KEY]` before navigation (`page.addInitScript`).

## 14. Test-id contract (`data-testid`) — UI and E2E must agree on these
Every interactive element below carries the given `data-testid`; cards also carry `data-id="<entity id>"`.

| testid | element |
|---|---|
| `app` | app root |
| `add-topic` | "+ Topic" button(s) (board empty state and the trailing column/page) |
| `topic-card` | topic column root (`data-id`) |
| `topic-title` | topic title input |
| `topic-grip`, `topic-menu` | grip handle, ⋯ menu button |
| `topic-chip` | "2/5 in set · 1:10" chip |
| `add-joke` | "+ Joke" button inside a topic |
| `joke-card` | joke card (`data-id`); has class `in-set` when selected |
| `joke-inset` | "In set" checkbox input |
| `joke-title`, `joke-text` | title input, text textarea |
| `joke-time` | time chip (text like `0:24 · 56w`) |
| `joke-grip`, `joke-menu` | grip handle, ⋯ menu button |
| `joke-badge` | set position badge (#3) |
| `use-original` | radio: use the joke's own text (shown when it has alts) |
| `add-alt` | "+ Alt" button inside a joke |
| `alt-card` | alt card (`data-id`) |
| `alt-use` | radio "Use this in set" |
| `alt-text` | alt textarea |
| `alt-grip`, `alt-menu` | grip handle, ⋯ menu button |
| `menu` | an open menu; items are `menu-item` with `data-action` (`rename`, `collapse`, `move-left`, `move-right`, `color-<name>`, `delete`, `add-alt`, `manual-time`, `move-to-topic`, `move-up`, `move-down`, `duplicate`, `promote`, `move-to-joke`) — "Move to…" items open a submenu/list whose entries are `menu-item` with `data-target="<id>"` |
| `set-panel` | set sidebar / tab content |
| `set-toggle` | desktop sidebar collapse button |
| `set-item` | set list row (`data-id`); contains `set-grip`, `set-title`, `set-time`, `set-remove` |
| `set-total`, `set-words`, `set-target`, `set-delta`, `set-bar` | footer elements |
| `undo`, `redo` | toolbar buttons |
| `version-switcher` | top bar version button; menu items `version-item` (`data-id`), `version-new`, `version-manage` |
| `version-dialog` | manage dialog; rows `version-row` (`data-id`) with `version-rename`, `version-duplicate`, `version-delete`; `version-new-blank` |
| `new-version-dialog` | with `new-version-name`, `new-version-from` (select: `current`/`blank`), `new-version-create` |
| `sync-dot` | sync status dot (`data-state` = status.state) |
| `settings-button` | gear (desktop) |
| `tab-board`, `tab-set`, `tab-more` | mobile tabs; `tab-set` text includes the live total |
| `topic-pager` | mobile pager; pills `pager-pill` (`data-index`) |
| `settings` | settings container (dialog or More view) |
| `wpm-input`, `pause-input`, `target-input` | pace inputs |
| `colwidth-select`, `theme-select` | appearance |
| `token-input`, `connect-button`, `sync-now`, `disconnect-button`, `sync-status`, `replace-remote` | sync |
| `export-button`, `import-input` (file input), `import-replace`, `import-merge`, `reset-button` | data |
| `dialog` | any open dialog; `dialog-confirm`, `dialog-cancel`, `dialog-input` for confirm/prompt dialogs |
| `toast` | toast element; `toast-action` button |
| `empty-board` | empty state |
| `install-nudge` | banner; `install-nudge-dismiss` |
