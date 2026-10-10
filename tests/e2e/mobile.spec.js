// iPhone layout (SPEC §9.1): bottom tabs, the paged board with its pager pills, the "+ Topic"
// page, the More view and the install nudge. Runs on the iphone project only.
import { test, expect } from '@playwright/test';
import { buildWorkspace, jokeCard, open, sampleWorkspace, seed, setItem, topicCard, words } from './helpers.js';

test.skip(({ isMobile }) => !isMobile, 'mobile layout only');

/** Current board page as the pager shows it. */
async function activePill(page) {
  return page.getByTestId('pager-pill').evaluateAll((els) => els.findIndex((el) => el.getAttribute('aria-current') === 'true'));
}

test('bottom tabs switch between Board, Set and More', async ({ page }) => {
  const { ws } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  await expect(page.getByTestId('tab-board')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('set-panel')).toHaveCount(0);
  await expect(page.getByTestId('settings-button')).toHaveCount(0); // no gear on mobile

  await page.getByTestId('tab-set').click();
  await expect(page.getByTestId('tab-set')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('set-panel')).toBeVisible();
  await expect(page.getByTestId('set-toggle')).toHaveCount(0);
  await expect(page.getByTestId('topic-card')).toHaveCount(0);

  await page.getByTestId('tab-more').click();
  await expect(page.getByTestId('tab-more')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('settings')).toBeVisible();
  await expect(page.locator('.more-versions')).toContainText('Set v1');
  for (const id of ['wpm-input', 'token-input', 'export-button', 'theme-select']) await expect(page.getByTestId(id)).toBeAttached();

  await page.getByTestId('tab-board').click();
  await expect(page.getByTestId('topic-card')).toHaveCount(2);
});

test('the board pages one topic at a time; the pager follows and drives it', async ({ page }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const board = page.locator('.board');
  const pills = page.getByTestId('pager-pill');
  await expect(pills).toHaveCount(3); // two topics + the "+" page
  await expect(pills.nth(0)).toHaveText('Airports');
  await expect(pills.nth(1)).toHaveText('Dating');
  expect(await activePill(page)).toBe(0);

  // Each column is exactly one board width wide and snaps.
  const boardBox = await board.boundingBox();
  const colBox = await topicCard(page, ids.airports).boundingBox();
  expect(Math.round(colBox.width)).toBe(Math.round(boardBox.width));
  await expect(board).toHaveCSS('scroll-snap-type', /x mandatory/);

  await pills.nth(1).click();
  await expect(pills.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => board.evaluate((el) => Math.round(el.scrollLeft / el.clientWidth))).toBe(1);
  await expect(topicCard(page, ids.dating)).toBeInViewport();

  // Scrolling the board (a swipe) updates the pager.
  await board.evaluate((el) => el.scrollTo({ left: 0, behavior: 'instant' }));
  await expect(pills.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(topicCard(page, ids.airports)).toBeInViewport();
});

test('the last page adds a topic and the new topic is shown and focused', async ({ page }) => {
  const { ws } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const pills = page.getByTestId('pager-pill');
  await pills.nth(2).click();
  await expect(pills.nth(2)).toHaveAttribute('aria-current', 'true');
  const addButton = page.getByTestId('add-topic');
  await expect(addButton).toBeInViewport();
  await addButton.click();
  await expect(page.getByTestId('topic-card')).toHaveCount(3);
  await expect(pills).toHaveCount(4);
  await expect(pills.nth(2)).toHaveAttribute('aria-current', 'true');
  const title = page.getByTestId('topic-card').nth(2).getByTestId('topic-title');
  await expect(title).toBeFocused();
  await expect(title).toBeInViewport();
  await title.fill('Third');
  await expect(pills.nth(2)).toHaveText('Third');

  // Move right from the menu follows the topic to its new page; delete shows the neighbour.
  await page.getByTestId('topic-card').nth(2).getByTestId('topic-menu').click();
  await page.getByTestId('menu').locator('[data-action="move-left"]').click();
  await expect(pills.nth(1)).toHaveText('Third');
  await expect(pills.nth(1)).toHaveAttribute('aria-current', 'true');
  await page.getByTestId('topic-card').nth(1).getByTestId('topic-menu').click();
  await page.getByTestId('menu').locator('[data-action="delete"]').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(pills).toHaveCount(3);
  await expect(pills.nth(1)).toHaveText('Dating');
  await expect(pills.nth(1)).toHaveAttribute('aria-current', 'true');
});

test('the install nudge appears for a browser tab with jokes and stays dismissed', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('install-nudge')).toHaveCount(0); // no jokes yet

  const { ws } = sampleWorkspace();
  await page.context().addInitScript(([key, json]) => localStorage.setItem(key, json), ['ssb.workspace.v1', JSON.stringify(ws)]);
  await page.reload();
  const nudge = page.getByTestId('install-nudge');
  await expect(nudge).toBeVisible();
  await expect(nudge).toContainText('Install to your Home Screen or connect Sync');
  await page.getByTestId('install-nudge-dismiss').click();
  await expect(nudge).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ssb.ui.installNudgeDismissed'))).toBe('true');
  await page.reload();
  await expect(page.getByTestId('topic-card')).toHaveCount(2);
  await expect(page.getByTestId('install-nudge')).toHaveCount(0);
});

/**
 * The real tappable extent of a control along `axis`: how many points on its centre line hit-test
 * to it (pseudo-elements that extend the hit area count, as a finger does not care about boxes;
 * a neighbour painting over it does not count, for the same reason).
 */
async function tapExtent(locator, axis = 'y') {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate((el, along) => {
    const b = el.getBoundingClientRect();
    const [lo, hi, fixed] = along === 'y' ? [b.top, b.bottom, b.left + b.width / 2] : [b.left, b.right, b.top + b.height / 2];
    let hits = 0;
    for (let p = Math.floor(lo) - 30; p <= Math.ceil(hi) + 30; p++) {
      const hit = along === 'y' ? document.elementFromPoint(fixed, p) : document.elementFromPoint(p, fixed);
      if (hit && el.contains(hit)) hits++;
    }
    return hits;
  }, axis);
}
const tapHeight = (locator) => tapExtent(locator, 'y');
const tapWidth = (locator) => tapExtent(locator, 'x');

test('touch targets: grips, tabs, menu items, pills, toggles, pager, "+" buttons and icon buttons are at least 44 px tall', async ({ page }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const airports = topicCard(page, ids.airports);
  const grip = await airports.getByTestId('joke-grip').first().boundingBox();
  expect(grip.width).toBeGreaterThanOrEqual(44);
  expect(grip.height).toBeGreaterThanOrEqual(44);
  const tab = await page.getByTestId('tab-set').boundingBox();
  expect(tab.height).toBeGreaterThanOrEqual(44);
  for (const testid of ['undo', 'sync-dot', 'version-switcher']) {
    expect((await page.getByTestId(testid).boundingBox()).height, testid).toBeGreaterThanOrEqual(44);
  }
  const security = jokeCard(page, ids.security);
  const controls = {
    'In set pill': security.locator('.inset-pill'),
    'joke menu': security.getByTestId('joke-menu'),
    'topic menu': airports.getByTestId('topic-menu'),
    '+ Joke': airports.getByTestId('add-joke'),
    '+ Alt': security.getByTestId('add-alt'),
    'pager pill': page.getByTestId('pager-pill').first(),
  };
  for (const [name, locator] of Object.entries(controls)) expect(await tapHeight(locator), name).toBeGreaterThanOrEqual(44);

  // Alts live on the Apps joke (Dating page).
  await page.getByTestId('pager-pill').nth(1).click();
  await expect(page.getByTestId('pager-pill').nth(1)).toHaveAttribute('aria-current', 'true');
  const apps = jokeCard(page, ids.apps);
  expect(await tapHeight(apps.locator('.alts-toggle')), 'alts toggle').toBeGreaterThanOrEqual(44);
  expect(await tapHeight(apps.locator('.radio-pill').first()), 'Use original pill').toBeGreaterThanOrEqual(44);
  expect(await tapHeight(apps.getByTestId('alt-card').first().locator('.pill')), 'alt Use this pill').toBeGreaterThanOrEqual(44);
  expect(await tapHeight(apps.getByTestId('alt-menu').first()), 'alt menu').toBeGreaterThanOrEqual(44);
  // The extended hit boxes stay inside their rows: the top of a textarea / title is the field itself,
  // not the pill or grip above it (a tap on the first text line must place the caret, not toggle the alt).
  const hitAtTop = (locator) => locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return [1, 2, 3].map((dy) => document.elementFromPoint(b.left + 40, b.top + dy) === el);
  });
  expect(await hitAtTop(apps.getByTestId('alt-card').first().getByTestId('alt-text')), 'alt textarea top rows').toEqual([true, true, true]);
  expect(await hitAtTop(apps.getByTestId('joke-title')), 'joke title top rows').toEqual([true, true, true]);
  // Widths: the grip keeps its whole box (the neighbouring pill's extender must not paint over its
  // right edge) and the pager's "+" page pill is as wide as it is tall.
  expect(await tapWidth(apps.getByTestId('joke-grip')), 'joke grip width').toBeGreaterThanOrEqual(44);
  expect(await tapWidth(apps.getByTestId('alt-grip').first()), 'alt grip width').toBeGreaterThanOrEqual(44);
  expect(await tapWidth(page.getByTestId('pager-pill').last()), '+ page pill width').toBeGreaterThanOrEqual(44);

  await apps.getByTestId('joke-menu').click();
  const item = await page.getByTestId('menu').locator('[data-action="add-alt"]').boundingBox();
  expect(item.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Escape');

  await page.getByTestId('tab-set').click();
  expect(await tapHeight(page.getByTestId('set-remove').first()), 'set remove').toBeGreaterThanOrEqual(44);
  expect(await tapHeight(page.getByTestId('set-menu').first()), 'set menu').toBeGreaterThanOrEqual(44);
  expect(await tapHeight(page.getByTestId('set-title').first()), 'set title').toBeGreaterThanOrEqual(44);

  // Every input and select of the More view.
  await page.getByTestId('tab-more').click();
  for (const testid of ['wpm-input', 'pause-input', 'target-input', 'token-input', 'theme-select', 'colwidth-select']) {
    expect(await tapHeight(page.getByTestId(testid)), testid).toBeGreaterThanOrEqual(44);
  }

  // The version name in Manage versions switches versions: it needs the same height.
  await page.getByTestId('version-switcher').click();
  await page.getByTestId('menu').getByTestId('version-manage').click();
  await page.getByTestId('version-dialog').getByTestId('version-new-blank').click();
  expect(await tapHeight(page.locator('.version-pick:not(:disabled)').first()), 'version pick').toBeGreaterThanOrEqual(44);
});

test('the action button of a toast is a 44 px target', async ({ page }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  // A failing save raises the persistent "export your data" toast, whose action is the smallest one.
  await page.evaluate((key) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === key) throw new Error('QuotaExceededError (simulated)');
      return setItem.call(this, k, v);
    };
  }, 'ssb.workspace.v1');
  await jokeCard(page, ids.luggage).getByTestId('joke-inset').check();
  const action = page.getByTestId('toast-action');
  await expect(action).toHaveText('Export');
  expect(await tapHeight(action), 'toast action').toBeGreaterThanOrEqual(44);
});

test('tapping a pager pill several pages away moves the highlight straight there', async ({ page }) => {
  const { ws } = buildWorkspace((w, m) => {
    for (let i = 1; i <= 5; i++) m.addJoke(w, m.addTopic(w, { title: `Topic ${i}` }), { title: `J${i}`, text: words(10) });
  });
  await seed(page, ws);
  await open(page);
  // Record every change of the highlighted pill: the smooth scroll passes pages 1–3 on its way and
  // the pager must not follow those (it used to read [4, 0, 1, 2, 3, 4]).
  await page.getByTestId('topic-pager').evaluate((pager) => {
    window.__pillSequence = [];
    new MutationObserver(() => {
      const pills = Array.from(pager.querySelectorAll('[data-testid="pager-pill"]'));
      const i = pills.findIndex((p) => p.getAttribute('aria-current') === 'true');
      const seq = window.__pillSequence;
      if (seq[seq.length - 1] !== i) seq.push(i);
    }).observe(pager, { attributes: true, subtree: true, attributeFilter: ['aria-current'] });
  });
  await page.getByTestId('pager-pill').nth(4).click();
  const board = page.locator('.board');
  await expect.poll(() => board.evaluate((el) => Math.round(el.scrollLeft / el.clientWidth))).toBe(4);
  await page.waitForTimeout(300); // any late scroll events
  expect(await page.evaluate(() => window.__pillSequence)).toEqual([4]);
  // Once there, a swipe is followed again.
  await board.evaluate((el) => el.scrollTo({ left: 0, behavior: 'instant' }));
  await expect(page.getByTestId('pager-pill').nth(0)).toHaveAttribute('aria-current', 'true');
});

test('a phone turned to landscape keeps the mobile layout and its touch targets', async ({ page }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await page.setViewportSize({ width: 844, height: 390 }); // iPhone 14 on its side: wider than the breakpoint
  await open(page);
  await expect(page.getByTestId('app')).toHaveClass(/is-mobile/);
  await expect(page.getByTestId('tab-board')).toBeVisible();
  await expect(page.getByTestId('settings-button')).toHaveCount(0);
  await expect(topicCard(page, ids.airports).getByTestId('topic-grip')).toBeHidden();
  for (const [name, locator] of Object.entries({
    'joke grip': jokeCard(page, ids.security).getByTestId('joke-grip'),
    'joke menu': jokeCard(page, ids.security).getByTestId('joke-menu'),
    'topic menu': topicCard(page, ids.airports).getByTestId('topic-menu'),
  })) {
    const box = await locator.boundingBox();
    expect(box.width, name).toBeGreaterThanOrEqual(44);
    expect(box.height, name).toBeGreaterThanOrEqual(44);
  }
  await jokeCard(page, ids.security).getByTestId('joke-menu').click();
  const item = await page.getByTestId('menu').locator('[data-action="add-alt"]').boundingBox();
  expect(item.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Escape');
  // Back to portrait, live.
  await page.setViewportSize({ width: 390, height: 664 });
  await expect(page.getByTestId('app')).toHaveClass(/is-mobile/);
  await expect(page.getByTestId('tab-board')).toBeVisible();
});

/**
 * Installs a fake visualViewport whose height the test shrinks with `window.__keyboard(px)`, as iOS
 * does when the keyboard appears (and grows back with `__keyboard(0)`). Its size is read lazily:
 * when an init script runs, Chromium has not applied the emulated viewport yet.
 */
async function installFakeKeyboard(page) {
  await page.addInitScript(() => {
    const listeners = [];
    let keyboardPx = 0;
    const vv = {
      get height() { return window.innerHeight - keyboardPx; },
      get width() { return window.innerWidth; },
      offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1,
      addEventListener: (type, fn) => { if (type === 'resize') listeners.push(fn); },
      removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); },
    };
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    window.__keyboard = (px) => { keyboardPx = px; listeners.forEach((fn) => fn(new Event('resize'))); };
  });
}

test('when the on-screen keyboard opens, the focused field is scrolled into the shrunken app', async ({ page }) => {
  await installFakeKeyboard(page);
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const text = jokeCard(page, ids.pretzels).getByTestId('joke-text'); // the lowest card on the first page
  await text.scrollIntoViewIfNeeded();
  await text.click();
  await expect(text).toBeFocused();
  await page.evaluate(() => window.__keyboard(336));
  await expect(page.locator('html')).toHaveClass(/kb-open/);
  await expect(page.getByTestId('tab-board')).toBeHidden();
  const geometry = await page.evaluate(() => {
    const el = document.activeElement;
    const field = el.getBoundingClientRect();
    const app = document.querySelector('[data-testid="app"]').getBoundingClientRect();
    const scroller = el.closest('.col-scroll').getBoundingClientRect();
    const header = el.closest('.topic-col').querySelector('.topic-card').getBoundingClientRect();
    const visible = Math.min(field.bottom, app.bottom) - Math.max(field.top, app.top);
    return { fieldTop: field.top, fieldHeight: field.height, appHeight: app.height, scrollerHeight: scroller.height, scrollerBottom: scroller.bottom, headerTop: header.top, visible };
  });
  expect(geometry.appHeight).toBe(664 - 336);
  // The column shrinks with the app (its scroller ends inside it) instead of overflowing and being
  // scrolled out of view together with the topic header.
  expect(geometry.scrollerBottom).toBeLessThanOrEqual(geometry.appHeight + 1);
  expect(geometry.headerTop).toBeGreaterThanOrEqual(0);
  // As much of the field as its column can show lies inside the shrunken app (all of it when it fits;
  // before the fix the field sat entirely below the app, under the keyboard).
  expect(geometry.visible, JSON.stringify(geometry)).toBeGreaterThanOrEqual(Math.min(geometry.fieldHeight, geometry.scrollerHeight) - 2);
});

test('with the keyboard up, a joke taller than its column is scrolled to the caret line, not its middle', async ({ page }) => {
  await installFakeKeyboard(page);
  const { ws, ids } = buildWorkspace((w, m) => ({ long: m.addJoke(w, m.addTopic(w, { title: 'Long' }), { title: 'Big', text: words(180, 'board') }) }));
  await seed(page, ws);
  await open(page);
  const text = jokeCard(page, ids.long).getByTestId('joke-text');
  const geometry = () => text.evaluate((el) => {
    const f = el.getBoundingClientRect();
    const scroller = el.closest('.col-scroll');
    const s = scroller.getBoundingClientRect();
    return { fieldTop: f.top, fieldBottom: f.bottom, fieldHeight: f.height, scrollerTop: s.top, scrollerBottom: s.bottom, scrollerHeight: s.height, scrollTop: scroller.scrollTop };
  });
  // Tap at the end of the joke to keep writing: caret at the end, the column showing the last line
  // (what iOS does on focus). Then the keyboard opens.
  await text.evaluate((el) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    const scroller = el.closest('.col-scroll');
    scroller.scrollTop = scroller.scrollHeight;
  });
  await page.evaluate(() => window.__keyboard(336));
  await expect(page.locator('html')).toHaveClass(/kb-open/);
  const atEnd = await geometry();
  expect(atEnd.fieldHeight, 'the joke is taller than the shrunken column').toBeGreaterThan(atEnd.scrollerHeight);
  // The caret line (the field's last line) is inside the visible part of the column — centring the
  // element put it ~460 px below it.
  expect(atEnd.fieldBottom, JSON.stringify(atEnd)).toBeLessThanOrEqual(atEnd.scrollerBottom + 1);
  expect(atEnd.fieldBottom, JSON.stringify(atEnd)).toBeGreaterThan(atEnd.scrollerTop + 20);
  // iOS reports the keyboard height over several resize events: a repeat leaves the scroll alone.
  await page.evaluate(() => window.__keyboard(336));
  expect((await geometry()).scrollTop).toBe(atEnd.scrollTop);
  // With the caret at the start, the first line is what gets revealed.
  await text.evaluate((el) => el.setSelectionRange(0, 0));
  await page.evaluate(() => window.__keyboard(336));
  const atStart = await geometry();
  expect(atStart.fieldTop, JSON.stringify(atStart)).toBeGreaterThanOrEqual(atStart.scrollerTop - 1);
  expect(atStart.fieldTop, JSON.stringify(atStart)).toBeLessThan(atStart.scrollerTop + 60);
});

test('a card menu opened while the keyboard is up lands in the visible area and survives the keyboard closing', async ({ page }) => {
  // Tapping ⋯ while editing blurs the textarea; iOS then retracts the keyboard, the column grows
  // back and its scroll position is clamped. That layout-driven scroll must not close the menu.
  await installFakeKeyboard(page);
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const card = jokeCard(page, ids.pretzels);
  const text = card.getByTestId('joke-text');
  await text.scrollIntoViewIfNeeded();
  await text.click();
  await page.evaluate(() => window.__keyboard(336));
  await expect(page.locator('html')).toHaveClass(/kb-open/);
  await card.getByTestId('joke-menu').click();
  const menu = page.getByTestId('menu');
  await expect(menu).toHaveCount(1);
  const menuBox = await menu.boundingBox();
  expect(menuBox.y + menuBox.height, 'menu inside the visual viewport (above the keyboard)').toBeLessThanOrEqual(664 - 336);

  await page.evaluate(() => window.__keyboard(0));
  await expect(page.locator('html')).not.toHaveClass(/kb-open/);
  // Whether the clamp moves this column depends on its height; make sure a scroll happens either way.
  await page.locator('.col-scroll').first().evaluate((el) => { el.scrollTop -= 30; });
  await page.waitForTimeout(300);
  await expect(menu).toHaveCount(1);
  await expect(menu.locator('[data-action="manual-time"]')).toBeVisible();
  // The menu followed its button (it sits right above or right below it again).
  const [button, moved] = await Promise.all([card.getByTestId('joke-menu').boundingBox(), menu.boundingBox()]);
  const adjacent = Math.abs(moved.y + moved.height + 4 - button.y) < 2 || Math.abs(moved.y - (button.y + button.height + 4)) < 2;
  expect(adjacent, JSON.stringify({ button, moved })).toBe(true);
});

test('revealing a joke taller than its column from the Set lands on its head, not mid-text', async ({ page }) => {
  const { ws, ids } = buildWorkspace((w, m) => {
    const a = m.addTopic(w, { title: 'Airports' });
    m.addJoke(w, a, { title: 'Short', text: words(10) });
    const parents = m.addTopic(w, { title: 'Parents' });
    const filler = m.addJoke(w, parents, { title: 'Filler', text: words(40, 'fill') });
    const tall = m.addJoke(w, parents, { title: 'Dad texts', text: words(160, 'dad') });
    m.addToSet(w, tall);
    return { filler, tall };
  });
  await seed(page, ws);
  await open(page);
  await page.getByTestId('tab-set').click();
  await setItem(page, ids.tall).getByTestId('set-title').click();
  const card = jokeCard(page, ids.tall);
  await expect(card).toHaveClass(/flash/);
  await expect(page.getByTestId('pager-pill').nth(1)).toHaveAttribute('aria-current', 'true');
  const geometry = await card.evaluate((el) => {
    const scroller = el.closest('.col-scroll').getBoundingClientRect();
    const head = el.querySelector('.joke-head').getBoundingClientRect();
    return { tallerThanColumn: el.offsetHeight > scroller.height, headTop: head.top, scrollerTop: scroller.top, scrollerBottom: scroller.bottom };
  });
  expect(geometry.tallerThanColumn).toBe(true);
  expect(geometry.headTop).toBeGreaterThanOrEqual(geometry.scrollerTop - 1);
  expect(geometry.headTop).toBeLessThan(geometry.scrollerTop + 40);
  await expect(card.getByTestId('joke-title')).toBeInViewport();
});
