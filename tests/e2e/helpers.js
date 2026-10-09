// Shared helpers for the Playwright suite (SPEC §13, §13.1, §14).
// Seeding builds real workspaces with js/model.js (the same code the app runs) and injects them
// into localStorage before navigation; interaction helpers encode the test-id contract once.
import { expect } from '@playwright/test';
import * as model from '../../js/model.js';
import { STORAGE_KEY, SYNC_KEY } from '../../js/storage.js';
import { countWords, formatDuration } from '../../js/timing.js';

export { STORAGE_KEY, SYNC_KEY, model };

/** Default pace (SPEC §1): 140 wpm + 2 s per joke. */
export const DEFAULTS = Object.freeze({ wpm: 140, pauseSec: 2, targetSec: 300 });

/** Seconds a joke of `text` takes at the given pace (mirrors jokeSeconds without an override). */
export function secondsFor(text, { wpm = DEFAULTS.wpm, pauseSec = DEFAULTS.pauseSec } = {}) {
  return (countWords(text) / wpm) * 60 + pauseSec;
}

/** Formatted "m:ss" estimate for a joke text at the default pace. */
export const estimate = (text, pace) => formatDuration(secondsFor(text, pace));

/** Expected content of a joke time chip: "0:24 · 56w". */
export const chipText = (text, pace) => `${estimate(text, pace)} · ${countWords(text)}w`;

/** Exactly `n` words, so timings are easy to reason about ("w1 w2 … wn"). */
export function words(n, prefix = 'word') {
  return Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join(' ');
}

// ---------------------------------------------------------------------------
// Workspace fixtures

/**
 * Builds a workspace with the real model. `build(ws, model)` performs mutations and returns any
 * ids the test wants to keep; the result is `{ ws, ids }`.
 */
export function buildWorkspace(build) {
  const ws = model.createWorkspace();
  const ids = build ? build(ws, model) || {} : {};
  return { ws, ids };
}

/**
 * The standard populated board used by most specs:
 *   Airports: "Security line" (in set #2), "Lost luggage", "Tiny pretzels" (in set #1)
 *   Dating:   "Apps" (with two alts), "First date"
 * Set order (Tiny pretzels, Security line) deliberately differs from board order.
 */
export function sampleWorkspace() {
  return buildWorkspace((ws, m) => {
    const airports = m.addTopic(ws, { title: 'Airports', color: 'sky' });
    const security = m.addJoke(ws, airports, { title: 'Security line', text: words(28, 'sec') });
    const luggage = m.addJoke(ws, airports, { title: 'Lost luggage', text: words(14, 'lug') });
    const pretzels = m.addJoke(ws, airports, { title: 'Tiny pretzels', text: words(42, 'pre') });
    const dating = m.addTopic(ws, { title: 'Dating' });
    const apps = m.addJoke(ws, dating, { title: 'Apps', text: words(21, 'app') });
    const altA = m.addAlt(ws, apps, { text: words(35, 'alta') });
    const altB = m.addAlt(ws, apps, { text: words(7, 'altb') });
    const firstDate = m.addJoke(ws, dating, { title: 'First date', text: words(10, 'date') });
    m.addToSet(ws, pretzels);
    m.addToSet(ws, security);
    return { airports, security, luggage, pretzels, dating, apps, altA, altB, firstDate };
  });
}

/**
 * Seeds `ws` under STORAGE_KEY before the first navigation of `page` (or a context). The init
 * script runs again on every reload, so it only writes while the key is still absent: what the
 * app saved afterwards must survive a reload exactly as it would for a user.
 */
export async function seed(target, ws) {
  await target.addInitScript(([key, json]) => {
    try {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, json);
    } catch {
      // Storage unavailable: the app falls back to an empty workspace and the test will say so.
    }
  }, [STORAGE_KEY, JSON.stringify(ws)]);
}

/**
 * The persisted workspace. Saves are debounced (150 ms) and flushed synchronously on `pagehide`
 * (SPEC §6), so the helper fires that event first instead of sleeping.
 */
export async function readStored(page) {
  return page.evaluate((key) => {
    window.dispatchEvent(new Event('pagehide'));
    return JSON.parse(localStorage.getItem(key));
  }, STORAGE_KEY);
}

/** Opens the app and waits for the first render. */
export async function open(page) {
  await page.goto('./');
  await expect(page.getByTestId('app')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Locators

/** A card / row with the given test id and entity id. */
export function byId(page, testid, id) {
  return page.locator(`[data-testid="${testid}"][data-id="${id}"]`);
}

export const topicCard = (page, id) => byId(page, 'topic-card', id);
export const jokeCard = (page, id) => byId(page, 'joke-card', id);
export const altCard = (page, id) => byId(page, 'alt-card', id);
export const setItem = (page, id) => byId(page, 'set-item', id);

/** Ids of the joke cards currently rendered, in DOM order (optionally within a scope). */
export async function jokeIdsOn(scope) {
  return scope.getByTestId('joke-card').evaluateAll((els) => els.map((el) => el.dataset.id));
}

/** Ids of the set rows in list order. */
export async function setOrder(page) {
  return page.getByTestId('set-item').evaluateAll((els) => els.map((el) => el.dataset.id));
}

// ---------------------------------------------------------------------------
// Navigation between views (mobile tabs are a no-op on desktop)

export async function showSet(page, isMobile) {
  if (isMobile) await page.getByTestId('tab-set').click();
  await expect(page.getByTestId('set-panel')).toBeVisible();
}

export async function showBoard(page, isMobile) {
  if (isMobile) await page.getByTestId('tab-board').click();
}

/** Opens Settings (gear dialog on desktop, More view on mobile) and returns its container. */
export async function openSettings(page, isMobile) {
  if (isMobile) await page.getByTestId('tab-more').click();
  else await page.getByTestId('settings-button').click();
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();
  return settings;
}

/** Closes the desktop settings dialog (Esc); nothing to do on mobile beyond switching tabs. */
export async function closeSettings(page, isMobile) {
  if (isMobile) await page.getByTestId('tab-board').click();
  else {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings')).toHaveCount(0);
  }
}

// ---------------------------------------------------------------------------
// Menus and dialogs

/** Clicks a ⋯ button and returns the open menu. */
export async function openMenu(page, button) {
  await button.click();
  const menu = page.getByTestId('menu');
  await expect(menu).toBeVisible();
  return menu;
}

/** Picks `data-action` from an open menu (and optionally a `data-target` from its submenu). */
export async function pickMenuItem(page, action, target) {
  const menu = page.getByTestId('menu');
  await menu.locator(`[data-testid="menu-item"][data-action="${action}"]`).click();
  if (target !== undefined) {
    await menu.locator(`[data-testid="menu-item"][data-target="${target}"]`).click();
  }
  await expect(menu).toHaveCount(0);
}

/** Opens the menu of `button` and picks an item in one go. */
export async function chooseFromMenu(page, button, action, target) {
  await openMenu(page, button);
  await pickMenuItem(page, action, target);
}

/**
 * The open confirm / prompt dialog. The settings dialog is a `dialog` too, so the one holding the
 * confirm button is the one meant here.
 */
export function confirmDialog(page) {
  return page.locator('[data-testid="dialog"]:has([data-testid="dialog-confirm"])');
}

/**
 * Confirms (or cancels) the open confirm/prompt dialog and waits until it is gone. A follow-up
 * confirm (double confirms) reuses the same element, so "gone" means its title has changed or the
 * element has been removed.
 */
export async function answerDialog(page, { confirm = true, text } = {}) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  const title = await dialog.locator('.dialog-title').innerText();
  if (text !== undefined) await dialog.getByTestId('dialog-input').fill(text);
  await dialog.getByTestId(confirm ? 'dialog-confirm' : 'dialog-cancel').click();
  await expect(dialog.filter({ has: page.locator('.dialog-title', { hasText: title }) })).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// Drag & drop (SPEC §13.1)

async function centerOf(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element has no bounding box (not rendered?)');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A point just inside an edge of a card: dropping there lands before (top/left) or after
 * (bottom/right) it. The card is scrolled into view first, as a user would before dropping, so
 * the point is one `elementFromPoint` can hit.
 */
export async function edgeOf(locator, side) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element has no bounding box (not rendered?)');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  switch (side) {
    case 'top': return { x, y: box.y + 3 };
    case 'bottom': return { x, y: box.y + box.height - 3 };
    case 'left': return { x: box.x + 3, y };
    case 'right': return { x: box.x + box.width - 3, y };
    default: throw new Error(`Unknown side ${side}`);
  }
}

/** Desktop: a real mouse drag from the grip to `to` (passes the 4 px start threshold first). */
export async function mouseDrag(page, grip, to) {
  const from = await centerOf(grip);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 8);
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
}

/**
 * Touch: synthetic pointer events drive the dnd controller exactly as §13.1 prescribes —
 * pointerdown on the grip, a 250 ms hold (>150 ms), pointermoves on document, pointerup.
 */
export async function touchDrag(page, grip, to) {
  const from = await centerOf(grip);
  const init = (x, y, extra = {}) => ({
    pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true, cancelable: true, ...extra,
  });
  await grip.evaluate((el, opts) => el.dispatchEvent(new PointerEvent('pointerdown', opts)), init(from.x, from.y));
  await page.waitForTimeout(250); // the touch hold that turns a tap into a drag
  await page.evaluate(([a, b]) => {
    document.dispatchEvent(new PointerEvent('pointermove', a));
    document.dispatchEvent(new PointerEvent('pointermove', b));
  }, [init(from.x + 6, from.y + 6), init(to.x, to.y)]);
  await expect(page.locator('body')).toHaveClass(/is-dragging/);
  await page.evaluate((opts) => document.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })), init(to.x, to.y, { button: 0 }));
  await expect(page.locator('body')).not.toHaveClass(/is-dragging/);
}

/** Drags with the input method of the current project. */
export async function drag(page, isMobile, grip, to) {
  if (isMobile) await touchDrag(page, grip, to);
  else await mouseDrag(page, grip, to);
}
