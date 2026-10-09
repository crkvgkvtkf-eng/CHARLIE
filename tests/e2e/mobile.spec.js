// iPhone layout (SPEC §9.1): bottom tabs, the paged board with its pager pills, the "+ Topic"
// page, the More view and the install nudge. Runs on the iphone project only.
import { test, expect } from '@playwright/test';
import { open, sampleWorkspace, seed, topicCard } from './helpers.js';

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

test('touch targets: grips, tabs and menu items are at least 44 px tall', async ({ page }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const grip = await topicCard(page, ids.airports).getByTestId('joke-grip').first().boundingBox();
  expect(grip.width).toBeGreaterThanOrEqual(44);
  expect(grip.height).toBeGreaterThanOrEqual(44);
  const tab = await page.getByTestId('tab-set').boundingBox();
  expect(tab.height).toBeGreaterThanOrEqual(44);
  await topicCard(page, ids.airports).getByTestId('joke-menu').first().click();
  const item = await page.getByTestId('menu').locator('[data-action="add-alt"]').boundingBox();
  expect(item.height).toBeGreaterThanOrEqual(44);
});
