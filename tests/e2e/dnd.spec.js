// Drag & drop (SPEC §9.4, §13.1): jokes within and across topics, alts, set rows and (desktop only)
// topic columns. Desktop drives the controller with page.mouse, the iPhone project with synthetic
// touch pointer events (pointerdown on the grip, 250 ms hold, pointermove on document, pointerup).
import { test, expect } from '@playwright/test';
import {
  altCard, drag, edgeOf, jokeCard, jokeIdsOn, mouseDrag, open, sampleWorkspace, seed, setItem, setOrder, showSet, topicCard,
} from './helpers.js';

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
