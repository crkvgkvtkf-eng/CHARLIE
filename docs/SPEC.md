# Stand-Up Set Builder — Specification

A flow-chart style app for writing a stand-up set. The writer creates **Topic** cards,
**Joke** cards under topics, and **Alt** (alternative) cards under jokes; selects jokes
into a **Set**; sees a running time estimate at a stand-up delivery pace; moves cards
around; undoes; keeps named **Versions**; and syncs across desktop and iPhone.

This document is the contract between modules. Module boundaries and function
signatures here are fixed; implementations may add internal helpers freely.

---

## 1. Product decisions (already made)

| Decision | Choice |
|---|---|
| Platform | One Progressive Web App (PWA). Desktop browser + iPhone Safari "Add to Home Screen". Works offline. |
| Hosting | GitHub Pages, "Deploy from a branch", root folder. Served under a sub-path (`https://<user>.github.io/CHARLIE/`), so **all URLs are relative** (`./`), never absolute (`/`). |
| Sync | Private GitHub Gist, token pasted once per device. Local-first: everything works without sync. Export/Import JSON always available. |
| Pace | Default 140 words per minute + 2 s laugh pause per joke. Both adjustable. Per-joke time override. Target length default 5:00. |
| Tech | No build step. Plain ES modules. Preact + htm vendored in `vendor/` (import via `js/lib.js`). CSS in `css/app.css`. No other runtime dependencies. |
| Tests | Unit: `node --test tests/unit/`. E2E: `@playwright/test` with `desktop` and `iphone` projects (`playwright.config.js`). |
| Browsers | iOS Safari 16.4+, current Chrome/Safari/Firefox/Edge desktop. |

## 2. File layout

```
index.html                 app shell (loads css/app.css, js/app.js as module, registers sw.js)
manifest.webmanifest       PWA manifest (relative start_url/scope, icons)
sw.js                      service worker: cache-first app shell, versioned cache, update notice
icons/icon.svg             source icon; icons/icon-192.png, icon-512.png, apple-touch-icon.png (180)
css/app.css                all styles; CSS variables; light + dark; desktop + mobile layouts
js/lib.js                  re-exports Preact/htm (already present — do not change)
js/ids.js                  newId(), nowIso() (injectable clock for tests)
js/model.js                pure workspace data model + mutations (no DOM, no storage)
js/timing.js               pure timing math
js/undo.js                 pure history stack
js/storage.js              localStorage persistence, export/import helpers, validation
js/sync.js                 GitHub Gist client + pure merge() + runSync()
js/store.js                state container: wraps model mutations with undo + persistence + subscribers
js/syncManager.js          auto-sync scheduler + status (uses sync.js + store.js)
js/app.js                  boot: load, create store, render <App/>, keyboard shortcuts, SW registration
js/ui/dnd.js               pointer-based drag & drop controller (mouse + touch), no framework coupling
js/ui/App.js               layout shell: top bar, board, set panel/tab, dialogs, toasts, responsive switch
js/ui/Board.js             topics → jokes → alts flow-chart board (+ card components)
js/ui/SetPanel.js          ordered set list, reorder, per-joke times, totals, target bar
js/ui/Versions.js          version switcher + manage dialog
js/ui/Settings.js          settings + sync + data (export/import) + help dialog
js/ui/common.js            Dialog, Menu, Toast, IconButton, AutoTextarea, TimeChip helpers
tests/unit/*.test.js       node --test
tests/e2e/*.spec.js        playwright
tests/serve.mjs            static server used by playwright webServer and `npm start`
README.md                  setup: enable Pages, create token, install on iPhone, run tests
docs/SPEC.md               this file
```

## 3. Data model (`js/model.js`)

All timestamps are ISO-8601 UTC strings (`new Date().toISOString()`); compared as strings.
All ids are opaque strings from `newId()` (`crypto.randomUUID()` when available, else
`Date.now().toString(36) + '-' + random`).

```js
Workspace {
  schemaVersion: 1,
  id: string,
  settings: Settings,
  settingsUpdatedAt: iso,
  activeVersionId: string,
  versions: Version[],            // at least one, ordered by createdAt (display order)
  tombstones: { [versionId]: iso }, // deleted version id -> deletion time (for sync merge)
  updatedAt: iso,
}
Settings { wpm: number (140), pauseSec: number (2), targetSec: number (300), theme: 'system'|'light'|'dark' }
Version {
  id, name: string, createdAt: iso, updatedAt: iso,
  topics: Topic[],                // display order left→right
  set: { jokeIds: string[], updatedAt: iso },   // THE source of truth for "in set" + order
}
Topic { id, title: string, color: string|null, collapsed: boolean, jokes: Joke[] }   // jokes in display order
Joke  { id, title: string, text: string, alts: Alt[], activeAltId: string|null, overrideSec: number|null, notes: string }
Alt   { id, text: string }
```

Rules:
- `title` is a short name (optional, may be ''). `text` is the joke as spoken; timing uses it.
- `activeAltId` = the alt whose text is delivered in the set instead of the joke's own text; `null` = joke's own text. If the referenced alt is removed, reset to `null`.
- "In set" is derived: `version.set.jokeIds.includes(joke.id)`. Removing a joke/topic removes its ids from the set. `jokeIds` never contains unknown ids (normalize on load).
- Every mutation that changes a version sets `version.updatedAt = now` and `workspace.updatedAt = now`; a set change also sets `set.updatedAt`. Settings changes set `settingsUpdatedAt` and `updatedAt`.
- A workspace always has ≥1 version. Deleting the last version is refused (throw `Error('Cannot delete the only version')`).

### 3.1 Exports (all mutations mutate the passed `ws` in place and return something useful)

```js
export function createWorkspace({ name = 'Set v1' } = {}) → Workspace     // one empty version, default settings
export function createVersion({ name, from = null }) → Version            // from: Version to deep-copy (new ids for topics/jokes/alts? NO — keep ids; see 3.2)
export function normalize(ws) → ws         // fills missing fields, drops dangling set ids / activeAltIds, ensures ≥1 version & valid activeVersionId. Idempotent. Used by storage + sync.
export function activeVersion(ws) → Version
export function findTopic(ws, topicId) → { version, topic, index } | null
export function findJoke(ws, jokeId)   → { version, topic, topicIndex, joke, index } | null
export function findAlt(ws, altId)     → { version, topic, joke, alt, index } | null
export function deliveredText(joke) → string      // active alt text or joke text

// topics
export function addTopic(ws, { title = '' } = {}, index = undefined) → topicId
export function updateTopic(ws, topicId, patch) → void      // patch ⊆ {title,color,collapsed}
export function removeTopic(ws, topicId) → void              // also removes its jokes from set
export function moveTopic(ws, topicId, toIndex) → void
// jokes
export function addJoke(ws, topicId, { title = '', text = '' } = {}, index = undefined) → jokeId
export function updateJoke(ws, jokeId, patch) → void         // patch ⊆ {title,text,notes,overrideSec,activeAltId}
export function removeJoke(ws, jokeId) → void
export function moveJoke(ws, jokeId, toTopicId, toIndex) → void   // same or different topic; toIndex is index in TARGET list after removal from source
// alts
export function addAlt(ws, jokeId, { text = '' } = {}, index = undefined) → altId
export function updateAlt(ws, altId, patch) → void           // patch ⊆ {text}
export function removeAlt(ws, altId) → void
export function moveAlt(ws, altId, toJokeId, toIndex) → void
export function setActiveAlt(ws, jokeId, altId | null) → void
export function promoteAlt(ws, altId) → void                 // swap alt.text with joke.text; activeAltId → null
// set
export function addToSet(ws, jokeId, index = undefined) → void   // no-op if present
export function removeFromSet(ws, jokeId) → void
export function toggleInSet(ws, jokeId) → boolean               // returns new inSet
export function moveInSet(ws, jokeId, toIndex) → void
export function isInSet(ws, jokeId) → boolean
// versions
export function addVersion(ws, { name, fromVersionId = ws.activeVersionId } = {}) → versionId   // fromVersionId=null → blank; new version becomes active
export function renameVersion(ws, versionId, name) → void
export function deleteVersion(ws, versionId) → void          // adds tombstone; if active, activate newest remaining
export function switchVersion(ws, versionId) → void
// settings
export function updateSettings(ws, patch) → void
```

### 3.2 Duplicating a version
`addVersion` with `fromVersionId` deep-copies topics/jokes/alts **with fresh ids** for every
topic, joke and alt (and remaps `set.jokeIds` and `activeAltId`). Fresh ids keep the two
versions independent in the future (e.g. per-entity merge). Name defaults to `"<from name> copy"`
if not provided.

Every `move*` with an out-of-range `toIndex` clamps. Unknown ids throw `Error`.

## 4. Timing (`js/timing.js`)

```js
export function countWords(text) → number   // tokens split on whitespace that contain ≥1 letter or digit (unicode aware: /[\p{L}\p{N}]/u). "—" alone is not a word. "don't" = 1. "5" = 1.
export function jokeSeconds(joke, settings) → number   // overrideSec ?? (countWords(deliveredText(joke)) / wpm * 60 + pauseSec). Never negative. Joke with 0 words and no override = pauseSec.
export function setEstimate(ws) → { totalSec, words, items: [{ jokeId, title, snippet, seconds, words, overridden }], targetSec, deltaSec, ratio }
   // items follow set.jokeIds order; snippet = first 60 chars of deliveredText, single-line; title = joke.title || snippet || 'Untitled joke'
export function topicEstimate(ws, topicId) → { inSet: number, total: number, seconds: number }  // jokes of this topic that are in the set
export function formatDuration(sec) → 'm:ss' (round to nearest second; ≥ 1 h shows 'h:mm:ss')
export function formatDelta(sec) → '+0:12' | '−0:12' | '0:00'   (use U+2212 minus)
```

## 5. Undo (`js/undo.js`)

```js
export function createHistory({ limit = 200 } = {}) → history
history.push(snapshot, { coalesceKey = null } = {})   // snapshot = immutable workspace object. If coalesceKey != null and equals the key of the last pushed entry, REPLACE the last entry's "after" state instead of pushing. Clears redo stack.
history.undo(current) → previousSnapshot | null
history.redo(current) → nextSnapshot | null
history.canUndo() / canRedo() → boolean
history.breakCoalescing()    // next push with any coalesceKey starts a new entry
history.clear()
```
Implementation: keep `past: Snapshot[]` (states BEFORE each change) and `future`. `push(before, ...)`
stores the state before the change; `undo(current)` pops past, pushes current to future.
Coalescing: when `coalesceKey` matches the last push's key, do not push a new "before" (the
first keystroke's before-state remains the undo target).

## 6. Storage (`js/storage.js`)

```js
export const STORAGE_KEY = 'ssb.workspace.v1'
export function loadWorkspace(storage = localStorage) → Workspace       // parse+normalize; on corrupt JSON → copy raw to `ssb.workspace.corrupt.<ts>` and return createWorkspace()
export function saveWorkspace(ws, storage = localStorage) → void        // JSON.stringify
export function serializeExport(ws) → string                            // pretty JSON, { app:'standup-set-builder', exportedAt, workspace }
export function parseImport(text) → Workspace                           // accepts export envelope OR bare workspace; validates shape; throws Error with a human message
export function downloadJson(filename, text) → void                      // Blob + <a download>; on iOS prefer navigator.share({ files }) when canShare
```
Local save is debounced in the store (≤150 ms), and flushed synchronously on `pagehide`/`visibilitychange→hidden`.

## 7. Sync (`js/sync.js`)

Transport: GitHub REST API, `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28`. Token: a **classic** personal access token with only the `gist`
scope (fine-grained tokens cannot access the Gist API). Gist is **secret** (`public: false`),
description `Stand-Up Set Builder data`, single file `standup-set-builder.json`.

```js
export const GIST_FILENAME = 'standup-set-builder.json'
export function createClient({ token, fetch = globalThis.fetch, baseUrl = 'https://api.github.com' }) → {
  findGist()                       → { id, updated_at } | null   // GET /gists?per_page=100 (follow up to 5 pages); first gist containing GIST_FILENAME
  createGist(contentString)        → { id }
  readGist(id)                     → { content: string, updated_at }   // if file.truncated, GET file.raw_url
  writeGist(id, contentString)     → { updated_at }
  whoami()                         → { login }                   // GET /user (validates token; needs no scope)
}
// Errors: throw SyncError(message, { status, kind: 'auth'|'network'|'notfound'|'ratelimit'|'other' })
export class SyncError extends Error

export function merge(local, remote, { lastSyncedAt = null } = {}) → { workspace, localChanged, remoteChanged, conflictCopies: string[] }
export async function runSync({ client, workspace, gistId = null, lastSyncedAt = null }) → { workspace, gistId, pushed: boolean, pulled: boolean, conflictCopies, remoteUpdatedAt }
```

### 7.1 Merge rules (pure, deterministic; `merge(a,b)` and `merge(b,a)` produce the same version set)
1. Tombstones: union; for the same id keep the later time.
2. Versions: union by id. For an id on both sides keep the one with later `updatedAt` (tie → local).
   Drop any version whose tombstone time is later than its `updatedAt` (deletion wins over older
   edits; an edit after deletion resurrects it).
3. **Conflict safety net**: if a local version loses to a remote copy AND the local copy has
   unsynced changes (`lastSyncedAt` is null or `local.updatedAt > lastSyncedAt`) AND its content
   differs (compare `JSON.stringify` of `{topics,set.jokeIds}`), keep the local copy as an
   additional version with a fresh id, name `"<name> (conflict copy)"`, `updatedAt = now`, and
   report its name in `conflictCopies`. Nothing is silently lost.
4. Settings: later `settingsUpdatedAt` wins (tie → local).
5. `activeVersionId`: local's if still present, else remote's if present, else first version.
6. Order versions by `createdAt`. `updatedAt` = max of both. `id`/`schemaVersion` from local.
7. `localChanged` = merged ≠ local (deep-equal via stable JSON); `remoteChanged` = merged ≠ remote.

### 7.2 `runSync` flow
1. If `gistId` null → `findGist()`; if none → `createGist(serialize(workspace))` → return `{pushed:true, pulled:false}`.
2. `readGist` → parse (via `storage.parseImport`-compatible envelope: the gist content is the same
   export envelope `{app, exportedAt, workspace}`) → `normalize`.
   Corrupt/unparseable remote → throw `SyncError(kind:'other', 'Remote data is unreadable')` (never overwrite it).
3. `merge(local, remote, {lastSyncedAt})`.
4. If `remoteChanged` → `writeGist`. Return merged workspace + flags.

### 7.3 Sync manager (`js/syncManager.js`)
```js
export function createSyncManager({ store, loadConfig, saveConfig, createClient = sync.createClient, now }) → mgr
mgr.getStatus() → { state: 'off'|'idle'|'syncing'|'error'|'offline', lastSyncAt, error: string|null, login: string|null, gistId }
mgr.subscribe(fn)
mgr.connect(token) → Promise<void>     // whoami() to validate; save {token, login}; then syncNow()
mgr.disconnect()                       // clear token/gistId/lastSyncedAt; status 'off'
mgr.syncNow() → Promise<void>          // guarded: one in-flight at a time; a request during flight sets `dirty` and re-runs once after
mgr.scheduleSync()                     // debounce 2500 ms; called by store change listener when the change was not sync-applied
mgr.start()                            // listeners: store changes → scheduleSync; window 'online' → syncNow; document visibilitychange→visible → syncNow; initial syncNow if connected
```
Config (`ssb.sync.v1` in localStorage): `{ token, login, gistId, lastSyncedAt }`.
When applying a merged workspace to the store use `store.replace(ws, { source: 'sync' })` so the
change listener does not reschedule a push (undo history is cleared on replace). Conflict copies
→ toast "Kept a conflict copy: <name>". Token is stored on the device only; the Settings UI
says so and shows only the last 4 characters.

## 8. Store (`js/store.js`)

```js
export function createStore(initialWorkspace, { persist = () => {}, history = createHistory() } = {}) → store
store.get() → Workspace                       // current immutable snapshot
store.subscribe(fn: (ws, meta) => void) → unsubscribe     // meta: { source: 'user'|'undo'|'redo'|'sync'|'import'|'replace' }
store.apply(label, mutator: (draft) => any, { coalesceKey = null } = {}) → any   // draft = structuredClone(current); runs mutator; pushes history (before-state); sets current; persist(); notify. Returns the mutator's return value. If mutator throws, state is unchanged and the error propagates.
store.undo() / store.redo() → boolean
store.canUndo() / store.canRedo() → boolean
store.breakCoalescing()
store.replace(ws, { source = 'replace', resetHistory = true } = {})  // normalize(ws), clear history, persist, notify
```
Convenience: `store.actions` object exposing every `model` mutation bound as `(...args) => store.apply(name, d => model.name(d, ...args))`; text edits use `coalesceKey` (e.g. `updateJoke` with a `text` patch uses key `joke:text:<id>`; `title` uses `joke:title:<id>`; same pattern for topics/alts/notes). `breakCoalescing()` is called on blur of any text field.

## 9. UI

### 9.1 Responsive layouts
- **Desktop (min-width 900px)**: top bar; main = board (horizontal scroll, topic columns 320px wide) + right sidebar "Set" (340px, collapsible via a button; collapsed state remembered in localStorage `ssb.ui.setCollapsed`).
- **Mobile (<900px)**: top bar (compact); content area = one of three views selected by a bottom tab bar: **Board**, **Set**, **More**. Board on mobile = topic columns at 100vw with horizontal `scroll-snap-type: x mandatory` (swipe between topics) and a topic pager (dots or pills) under the top bar; "+ Topic" is the last snap page. Bottom bar respects `env(safe-area-inset-bottom)`. Body uses `100dvh`; no page-level scrolling (each column/list scrolls).
- iOS specifics: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style=black-translucent`, `apple-touch-icon`, font-size ≥16px on inputs (prevents zoom), `-webkit-tap-highlight-color: transparent`, `overscroll-behavior: none` on scroll containers.

### 9.2 Top bar
App name ("Set Builder"), version switcher (current version name → menu listing versions, "New version…", "Manage versions…"), Undo / Redo icon buttons (disabled when unavailable; tooltips with shortcut), sync status dot (off=grey, idle=green, syncing=animated, error=red with message on click → opens Settings), Settings gear. On mobile only: version name (tap → versions), undo, redo, overflow.

### 9.3 Board (flow chart)
Each topic is a column:
```
┌ Topic card ───────────────┐   grip · editable title · "2/5 in set · 1:10" chip · ⋯ menu
│                           │
└──────┬────────────────────┘
       ├─ ┌ Joke card ─┐    (connector lines drawn with CSS: vertical spine + horizontal stubs)
       │  │ [✓ In set] grip title · time chip "0:24 · 56w" · ⋯ │
       │  │ textarea (auto-grow)                              │
       │  │   └─ Alt card: ( ) Use this · textarea · ⋯          │
       │  │   └─ Alt card …                                     │
       │  │   [+ Alt]                                            │
       ├─ ┌ Joke card ─┐
       └─ [+ Joke]
```
- Topic menu: Rename (focus title), Collapse/Expand jokes, Move left/right, Color (6 presets + none), Delete topic (confirm; shows joke count).
- Joke card: "In set" checkbox pill (adds to end of set / removes); title input (placeholder "Joke title"); text textarea (placeholder "Write the joke as you'd say it…"); time chip reflects delivered text + override (override shown with a ⏱ marker and tooltip "Manual time"); alts section collapsed by default when the joke has >0 alts? No — alts are visible (expanded) by default; a small "▾ 2 alts" toggle collapses them (ui-only state, not persisted). Menu: Add alt, Use original text (when an alt is active), Set manual time… (prompt dialog m:ss; blank clears), Move to topic… (submenu/list), Move up / Move down, Duplicate joke, Delete joke (confirm if text non-empty).
- Alt card: radio "Use this in set" (sets activeAltId; the joke card's own text shows a "Use original" radio at the top of the alt list so the user can switch back), textarea, menu: Make this the main joke (promoteAlt), Move to joke… , Move up/down, Delete alt.
- Selected (in-set) jokes get an accent left border and a badge with their set position (#3).
- Empty board: centered empty state with "+ Add your first topic".
- Keyboard: Enter in a title input moves focus to text. Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z (and Ctrl+Y) = undo/redo when focus is NOT in a text field (text fields keep native undo); the toolbar buttons always use app history. Esc closes menus/dialogs.

### 9.4 Drag & drop (`js/ui/dnd.js`)
Pointer-events based (works for mouse, pen, touch). Every draggable has a **grip handle** with `touch-action: none`; dragging starts on `pointerdown` on a grip after moving 4px (mouse) or immediately after 150 ms hold (touch). While dragging: a translucent ghost of the card follows the pointer; the source gets `.is-dragging` (dimmed); the nearest valid drop target shows an insertion indicator line; containers auto-scroll when the pointer is within 40px of their edge (vertical lists and the horizontal board). Drop → callback. Esc cancels. Three drag kinds: `topic` (reorder columns, horizontal), `joke` (reorder within topic or move across topics; containers `[data-drop="jokes"][data-topic-id]`), `alt` (within/between jokes; `[data-drop="alts"][data-joke-id]`), `set` (reorder in set list; `[data-drop="set"]`). API:
```js
export function createDnd({ onDrop }) → { attach(gripEl, { kind, id, cardEl }), detach(gripEl), destroy() }
// onDrop({ kind, id, containerId, index })  — index = insertion index among the container's current children excluding the dragged card
```
Insertion index computation: compare pointer coordinate to midpoints of the container's child cards (`[data-card]`), vertical for lists, horizontal for topics. Menus (Move up/down, Move to…) are the keyboard/accessibility fallback and must always exist.

### 9.5 Set panel / Set tab
Header "Set" with count ("6 jokes"). Ordered list: position, grip, title (or snippet), topic name (small), time; tap/click title → scrolls board to that joke and flashes it. Remove (×) button. Footer: **Total** big (m:ss), words, target (m:ss, editable via Settings), delta (“+0:12 over” red / “−0:40 under” / “on target” when |delta| ≤ 5 s), progress bar (ratio to target; color: under 85% neutral, 85–105% green, >105% red). Empty: "Tick 'In set' on a joke to build your set." Order in the set is independent of board position.

### 9.6 Versions
Switcher in the top bar. Manage dialog: list (name, updated time, counts), Rename (inline), Duplicate, Delete (confirm; refused for the only version), "New blank version". New version dialog: name input defaulting to `"<current> copy"`, option "Start from: current version / blank". Switching versions is an undoable action.

### 9.7 Settings dialog (tabs or sections)
- **Pace**: Words per minute (number, 60–300, default 140); Pause per joke (seconds, 0–30, default 2); Target length (m:ss, default 5:00). Live example: "700 words ≈ 5:00 at 140 wpm" updates.
- **Sync**: explanation (one paragraph), link to create a classic token with `gist` scope (`https://github.com/settings/tokens/new?scopes=gist&description=Stand-Up%20Set%20Builder`), token input (type=password, autocomplete=off), Connect → shows "Connected as <login>", gist link, last synced, Sync now, Disconnect. Error text when any. Note: "Your token is stored only on this device."
- **Data**: Export JSON (download/share), Import JSON (file input → choose Replace or Merge → confirm), "Reset all data" (double confirm).
- **Appearance**: theme system/light/dark.
- **Help**: how to install on iPhone (Share → Add to Home Screen) and desktop (Install app from browser menu), keyboard shortcuts.

### 9.8 Toasts & dialogs
Toast bottom-center (above the mobile tab bar), auto-dismiss 3 s, with optional action ("Undo", "Reload"). Dialogs are `<dialog>`-like overlays implemented in Preact (focus trap, Esc closes, click outside closes), mobile: full-width sheet from bottom.

### 9.9 Visual design
Clean, high-contrast, card-based. CSS variables on `:root` (light) and `[data-theme=dark]` / `prefers-color-scheme` (dark). Accent color for in-set state. Topic colors are soft tints applied to the topic header and connector lines. System font stack. Connector lines 2px, `var(--line)`. Card radius 10px, subtle shadow. Minimum tap target 44px on mobile. Reduced motion respected.

## 10. Service worker (`sw.js`)
- `CACHE = 'ssb-v<N>'` (bump N on every deploy that changes assets; agents editing assets must bump it).
- Precache list: `./`, `./index.html`, `./manifest.webmanifest`, `./css/app.css`, every `./js/**` module, `./vendor/*.js`, icons.
- Fetch: same-origin GET → cache-first, falling back to network and caching the response; navigation requests fall back to cached `./index.html`. Cross-origin (api.github.com) → network only, never cached.
- Activate: delete other `ssb-*` caches, `clients.claim()`. `skipWaiting` on message `{type:'SKIP_WAITING'}`. App shows a toast "Update available · Reload" when a new worker is waiting.

## 11. First run
Empty workspace with one version "Set v1", no topics; board shows the empty state. No sample data.

## 12. Accessibility & robustness
- All icon buttons have `aria-label`. Menus are keyboard navigable. Dialog focus trap.
- The app never loses user text: save on every change (debounced) + flush on pagehide; sync never overwrites remote with corrupt data; import validates.
- Any uncaught error during boot shows a plain-HTML fallback message with an "Export my data" button that dumps localStorage, instead of a blank page.

## 13. Testing requirements
Unit tests (node --test) for: model (every mutation incl. clamping, dangling-id normalization, duplication id remap), timing (word counting edge cases, override, formatting), undo (coalescing, redo clearing, limit), storage (corrupt JSON recovery, import validation), sync.merge (all rules incl. tombstones + conflict copies, symmetry), runSync (with a fake fetch implementing the gist endpoints), store (apply/undo/redo/replace/persist), syncManager (debounce + in-flight guard with fake timers).
E2E (playwright, both projects): create topic/joke/alt, in-set toggle + total time, reorder via menu AND via drag (desktop pointer drag; iphone touch drag), undo/redo, versions create/switch/delete, settings wpm change updates total, export produces JSON, import restores, offline reload works after first load (service worker), two-context sync through a mocked GitHub API (`page.route('https://api.github.com/**')`).
