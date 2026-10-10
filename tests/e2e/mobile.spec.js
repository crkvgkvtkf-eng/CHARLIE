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
 * The real tappable height of a control: how many points on its vertical centre line hit-test to
 * it (pseudo-elements that extend the hit area count, as a finger does not care about boxes).
 */
async function tapHeight(locator) {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const x = b.left + b.width / 2;
    let hits = 0;
    for (let y = Math.floor(b.top) - 30; y <= Math.ceil(b.bottom) + 30; y++) {
      const hit = document.elementFromPoint(x, y);
      if (hit && el.contains(hit)) hits++;
    }
    return hits;
  });
}

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

  await apps.getByTestId('joke-menu').click();
  const item = await page.getByTestId('menu').locator('[data-action="add-alt"]').boundingBox();
  expect(item.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Escape');

  await page.getByTestId('tab-set').click();
  expect(await tapHeight(page.getByTestId('set-remove').first()), 'set remove').toBeGreaterThanOrEqual(44);
});

test('when the on-screen keyboard opens, the focused field is scrolled into the shrunken app', async ({ page }) => {
  // A fake visualViewport whose height the test shrinks, as iOS does when the keyboard appears. Its
  // size is read lazily: when an init script runs, Chromium has not applied the emulated viewport yet.
  await page.addInitScript(() => {
    const listeners = [];
    let keyboardPx = 0;
    const vv = {
      get height() { return window.innerHeight - keyboardPx; },
      get width() { return window.innerWidth; },
      offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1,
      addEventListener: (type, fn) => { if (type === 'resize') listeners.push(fn); },
      removeEventListener: () => {},
    };
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    window.__keyboard = (px) => { keyboardPx = px; listeners.forEach((fn) => fn(new Event('resize'))); };
  });
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
