// Drag & drop (SPEC §9.4, §13.1): jokes within and across topics, alts, set rows and (desktop only)
// topic columns. Desktop drives the controller with page.mouse, the iPhone project with synthetic
// touch pointer events (pointerdown on the grip, 250 ms hold, pointermove on document, pointerup).
import { test, expect } from '@playwright/test';
import {
  altCard, drag, edgeOf, jokeCard, jokeIdsOn, mouseDrag, open, sampleWorkspace, seed, setItem, setOrder, showSet, topicCard,
} from './helpers.js';

const touchInit = (x, y) => ({ pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true, cancelable: true });

/** Starts a drag from `grip` and parks the pointer at `to` without releasing (mouse or synthetic touch). */
async function beginDrag(page, isMobile, grip, to) {
  const box = await grip.boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (isMobile) {
    await grip.evaluate((el, opts) => el.dispatchEvent(new PointerEvent('pointerdown', opts)), touchInit(from.x, from.y));
    await page.waitForTimeout(250);
    await page.evaluate((opts) => document.dispatchEvent(new PointerEvent('pointermove', opts)), touchInit(to.x, to.y));
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 8, from.y + 8);
    await page.mouse.move(to.x, to.y, { steps: 6 });
  }
  await expect(page.locator('body')).toHaveClass(/is-dragging/);
}

async function endDrag(page, isMobile, at) {
  if (isMobile) await page.evaluate((opts) => document.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })), touchInit(at.x, at.y));
  else await page.mouse.up();
  await expect(page.locator('body')).not.toHaveClass(/is-dragging/);
}

test('a joke dragged below the last card of its topic moves to the end', async ({ page, isMobile }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const airports = topicCard(page, ids.airports);
  await drag(page, isMobile, jokeCard(page, ids.security).getByTestId('joke-grip'), await edgeOf(jokeCard(page, ids.pretzels), 'bottom'));
  expect(await jokeIdsOn(airports)).toEqual([ids.luggage, ids.pretzels, ids.security]);
  // The set order is untouched by board moves; badges still show set positions.
  await expect(jokeCard(page, ids.pretzels).getByTestId('joke-badge')).toHaveText('#1');
  await expect(jokeCard(page, ids.security).getByTestId('joke-badge')).toHaveText('#2');
  await expect(page.locator('body')).not.toHaveClass(/is-dragging/);
  await expect(page.locator('.dnd-ghost')).toHaveCount(0);
});

test('a joke dragged above the first card moves to the top', async ({ page, isMobile }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  await drag(page, isMobile, jokeCard(page, ids.pretzels).getByTestId('joke-grip'), await edgeOf(jokeCard(page, ids.security), 'top'));
  expect(await jokeIdsOn(topicCard(page, ids.airports))).toEqual([ids.pretzels, ids.security, ids.luggage]);
});

test('an alt can be reordered by dragging its grip', async ({ page, isMobile }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const apps = jokeCard(page, ids.apps);
  if (isMobile) await page.getByTestId('pager-pill').nth(1).click();
  await expect(apps).toBeInViewport();
  await drag(page, isMobile, altCard(page, ids.altB).getByTestId('alt-grip'), await edgeOf(altCard(page, ids.altA), 'top'));
  await expect(apps.getByTestId('alt-card').nth(0)).toHaveAttribute('data-id', ids.altB);
  await expect(apps.getByTestId('alt-card').nth(1)).toHaveAttribute('data-id', ids.altA);
});

test('set rows reorder by drag without touching the board', async ({ page, isMobile }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  await showSet(page, isMobile);
  expect(await setOrder(page)).toEqual([ids.pretzels, ids.security]);
  await drag(page, isMobile, setItem(page, ids.pretzels).getByTestId('set-grip'), await edgeOf(setItem(page, ids.security), 'bottom'));
  expect(await setOrder(page)).toEqual([ids.security, ids.pretzels]);
  if (isMobile) await page.getByTestId('tab-board').click();
  await expect(jokeCard(page, ids.security).getByTestId('joke-badge')).toHaveText('#1');
  await expect(jokeCard(page, ids.pretzels).getByTestId('joke-badge')).toHaveText('#2');
  expect(await jokeIdsOn(topicCard(page, ids.airports))).toEqual([ids.security, ids.luggage, ids.pretzels]);
});

test('the ghost shows the whole header row: a readable joke title, and position/title/topic/time for a set row', async ({ page, isMobile }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const ghost = page.locator('.dnd-ghost');

  // Joke: the header keeps its grid layout inside the ghost, so the title input spans the full width.
  const grip = jokeCard(page, ids.security).getByTestId('joke-grip');
  const start = await grip.boundingBox();
  const parked = { x: start.x + 30, y: start.y + 70 };
  await beginDrag(page, isMobile, grip, parked);
  await expect(ghost).toHaveCount(1);
  const head = ghost.locator('.joke-head');
  await expect(head).toHaveCSS('display', 'grid');
  await expect(ghost.locator('.joke-title')).toHaveValue('Security line');
  const ghostBox = await ghost.boundingBox();
  const titleBox = await ghost.locator('.joke-title').boundingBox();
  expect(titleBox.width).toBeGreaterThan(ghostBox.width * 0.8);
  expect(ghostBox.height).toBeLessThanOrEqual(72);
  await endDrag(page, isMobile, parked);
  await expect(ghost).toHaveCount(0);

  // Set row: the row itself is the header, so the ghost is the row (not just its position number).
  await showSet(page, isMobile);
  const setGrip = setItem(page, ids.pretzels).getByTestId('set-grip');
  const rowStart = await setGrip.boundingBox();
  const rowParked = { x: rowStart.x + 20, y: rowStart.y + 40 };
  await beginDrag(page, isMobile, setGrip, rowParked);
  await expect(ghost.locator('.set-title-text')).toHaveText('Tiny pretzels');
  await expect(ghost.locator('.set-topic')).toHaveText('Airports');
  await expect(ghost.locator('.set-time')).toBeVisible();
  await endDrag(page, isMobile, rowParked);
  expect(await setOrder(page)).toEqual([ids.pretzels, ids.security]); // parked over its own slot: nothing moved
});

test('Escape cancels a drag in progress', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Escape needs a hardware keyboard');
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const grip = jokeCard(page, ids.security).getByTestId('joke-grip');
  const from = await grip.boundingBox();
  const to = await edgeOf(jokeCard(page, ids.pretzels), 'bottom');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect(page.locator('body')).toHaveClass(/is-dragging/);
  await expect(page.locator('.dnd-ghost')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/is-dragging/);
  await page.mouse.up();
  expect(await jokeIdsOn(topicCard(page, ids.airports))).toEqual([ids.security, ids.luggage, ids.pretzels]);
});

test.describe('desktop only', () => {
  test.skip(({ isMobile }) => isMobile, 'cross-topic mouse drags and column drags are desktop interactions');

  test('a joke dragged onto another topic column joins it at the pointer position', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    await mouseDrag(page, jokeCard(page, ids.luggage).getByTestId('joke-grip'), await edgeOf(jokeCard(page, ids.firstDate), 'top'));
    expect(await jokeIdsOn(topicCard(page, ids.airports))).toEqual([ids.security, ids.pretzels]);
    expect(await jokeIdsOn(topicCard(page, ids.dating))).toEqual([ids.apps, ids.luggage, ids.firstDate]);
  });

  test('topic columns reorder horizontally by their grip', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    await mouseDrag(page, topicCard(page, ids.airports).getByTestId('topic-grip'), await edgeOf(topicCard(page, ids.dating), 'right'));
    await expect(page.getByTestId('topic-card').nth(0)).toHaveAttribute('data-id', ids.dating);
    await expect(page.getByTestId('topic-card').nth(1)).toHaveAttribute('data-id', ids.airports);
  });
});

test.describe('iphone only', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch gestures are exercised on the iPhone project');

  test('a short touch on a grip is a tap, not a drag, and the topic grip is hidden', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    await expect(topicCard(page, ids.airports).getByTestId('topic-grip')).toBeHidden();
    const grip = jokeCard(page, ids.security).getByTestId('joke-grip');
    const box = await grip.boundingBox();
    const init = { pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: box.x + 10, clientY: box.y + 10, button: 0, buttons: 1, bubbles: true };
    await grip.evaluate((el, opts) => el.dispatchEvent(new PointerEvent('pointerdown', opts)), init);
    await grip.evaluate((el, opts) => el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })), init);
    await page.waitForTimeout(250);
    await expect(page.locator('body')).not.toHaveClass(/is-dragging/);
    expect(await jokeIdsOn(topicCard(page, ids.airports))).toEqual([ids.security, ids.luggage, ids.pretzels]);
  });

  test('holding the left part of a joke grip without moving neither pages the board nor moves the joke', async ({ page }) => {
    // Joke grips sit inside the 40 px left edge zone; the zone the drag starts in must not count as a dwell.
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    await page.getByTestId('pager-pill').nth(1).click();
    await expect(page.getByTestId('pager-pill').nth(1)).toHaveAttribute('aria-current', 'true');
    const board = page.locator('.board');
    await expect.poll(() => board.evaluate((el) => Math.abs(el.scrollLeft - el.clientWidth) < 1)).toBe(true); // smooth scroll settled
    const grip = jokeCard(page, ids.firstDate).getByTestId('joke-grip');
    const box = await grip.boundingBox();
    const at = { x: box.x + 6, y: box.y + box.height / 2 };
    expect(at.x).toBeLessThan(40);
    await grip.evaluate((el, opts) => el.dispatchEvent(new PointerEvent('pointerdown', opts)), touchInit(at.x, at.y));
    await page.waitForTimeout(800); // well past the 150 ms hold and the 500 ms paging dwell
    await expect(page.locator('body')).toHaveClass(/is-dragging/);
    await expect(page.getByTestId('pager-pill').nth(1)).toHaveAttribute('aria-current', 'true');
    expect(await board.evaluate((el) => Math.round(el.scrollLeft / el.clientWidth))).toBe(1);
    await page.evaluate((opts) => document.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })), touchInit(at.x, at.y));
    await expect(page.locator('body')).not.toHaveClass(/is-dragging/);
    expect(await jokeIdsOn(topicCard(page, ids.dating))).toEqual([ids.apps, ids.firstDate]);
    expect(await jokeIdsOn(topicCard(page, ids.airports))).toEqual([ids.security, ids.luggage, ids.pretzels]);
  });

  test('holding near the board edge pages to the next topic and drops there', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    const grip = jokeCard(page, ids.luggage).getByTestId('joke-grip');
    const from = await grip.boundingBox();
    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const init = (x, y) => ({ pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true, cancelable: true });
    await grip.evaluate((el, opts) => el.dispatchEvent(new PointerEvent('pointerdown', opts)), init(start.x, start.y));
    await page.waitForTimeout(250);
    const board = await page.locator('.board').boundingBox();
    const edge = { x: board.x + board.width - 10, y: start.y };
    await page.evaluate((opts) => document.dispatchEvent(new PointerEvent('pointermove', opts)), init(edge.x, edge.y));
    await expect(page.locator('.board')).toHaveClass(/is-dragging-board/);
    // After the 500 ms dwell the board shows the Dating column under the still pointer.
    await expect(page.getByTestId('pager-pill').nth(1)).toHaveAttribute('aria-current', 'true');
    const target = await edgeOf(jokeCard(page, ids.firstDate), 'bottom');
    await page.evaluate((opts) => document.dispatchEvent(new PointerEvent('pointermove', opts)), init(target.x, target.y));
    await page.evaluate((opts) => document.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })), init(target.x, target.y));
    await expect(page.locator('body')).not.toHaveClass(/is-dragging/);
    expect(await jokeIdsOn(topicCard(page, ids.dating))).toEqual([ids.apps, ids.firstDate, ids.luggage]);
    expect(await jokeIdsOn(topicCard(page, ids.airports))).toEqual([ids.security, ids.pretzels]);
  });
});
