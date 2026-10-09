# Stand-Up Set Builder

A flow-chart style app for writing a stand-up set.

- **Topic** cards → **Joke** cards underneath → **Alt** (alternative) cards underneath those.
- Tick jokes into your **Set**, drag them into order, and see a running time estimate
  at a stand-up delivery pace (default 140 words per minute plus a 2-second laugh pause per joke, both adjustable; any joke can get a manual time).
- Move cards around (drag, or the card menu), with **undo / redo**.
- Keep named **Versions** of the set (duplicate, rename, switch, delete).
- Works on **desktop and iPhone** from one codebase, installs to the iPhone home screen, works offline,
  and **syncs between devices** through a private GitHub Gist. Export / import JSON any time.

No build step: plain HTML, CSS and ES modules. Preact is vendored in `vendor/`.

## 1. Turn on hosting (one time, about a minute)

The app is served by GitHub Pages straight from this repository.

1. On GitHub open the repository → **Settings** → **Pages**.
2. Under **Build and deployment** choose **Source: Deploy from a branch**.
3. Pick the branch that holds the app (`claude/standup-set-builder-wmo46i`, or `main` after merging) and folder **/ (root)**. Save.
4. After a minute the page reports the URL, normally `https://<your-github-user>.github.io/CHARLIE/`.

Every push to that branch updates the live app. Installed copies pick the update up on the next launch
(a toast says "Update available · Reload").

## 2. Install it

- **iPhone:** open the URL in Safari → Share → **Add to Home Screen**. It then opens full screen, works offline, and keeps its own data.
- **Mac / desktop:** open the URL in Chrome, Edge or Safari. Chrome/Edge: address-bar **Install** icon. Safari (macOS Sonoma+): File → **Add to Dock**. Plain browser tabs work too.

## 3. Sync desktop ↔ iPhone (optional, one token)

Your data lives on each device. To keep devices in step, the app stores a copy in a **secret GitHub Gist** in your account.

1. Create a token: <https://github.com/settings/tokens/new?scopes=gist&description=Stand-Up%20Set%20Builder>
   (a *classic* token with only the **gist** scope; fine-grained tokens cannot use the Gist API). Pick an expiry you're happy with and copy the token.
2. In the app: Settings (gear) → **Sync** → paste the token → **Connect**.
3. Repeat step 2 on the other device with the same token. The app finds the same gist automatically.

Sync runs by itself (a couple of seconds after you stop editing, when the app opens, and when it returns to the foreground). If the same version was edited on both devices while offline, the newest copy wins and the other is kept as "<name> (conflict copy)" so nothing is lost. The token is stored only on your devices; you can revoke it on GitHub any time.

**No token?** Settings → **Data** → Export JSON, then AirDrop / Files it to the other device and Import.

## 4. Run locally

```bash
npm install          # only installs the Playwright test runner
npm start            # serves the app at http://127.0.0.1:4173/
```

## 5. Tests

```bash
npm run test:unit    # data model, timing, undo, storage, sync merge (node --test)
npm run test:e2e     # Playwright, desktop + iPhone projects (first time: npx playwright install chromium)
npm test             # both
```

## 6. Native iOS app (optional, later)

The web app is the whole product; a native shell only re-uses it. From a Mac with Xcode: wrap the
app in a `WKWebView` (or Capacitor) project pointing at the hosted URL or bundling these files, build
and run it in the iOS Simulator, then distribute through TestFlight with an Apple developer account.
Everything here (data, sync, undo, versions) works unchanged inside that shell.

## Project layout

See `docs/SPEC.md` for the full specification (data model, module contracts, UI behaviour, sync rules).

```
index.html  manifest.webmanifest  sw.js        app shell, PWA manifest, service worker
css/app.css                                     styles (light/dark, desktop/mobile)
js/                                             app code (ES modules, no build)
  model.js timing.js undo.js storage.js         pure logic
  sync.js syncManager.js store.js               gist sync, auto-sync, state container
  ui/                                           Preact components + drag & drop
vendor/                                         Preact + htm (MIT)
tests/unit  tests/e2e                           node --test and Playwright
```
