// Drag & drop (SPEC §9.4, §13.1): jokes within and across topics, alts, set rows and (desktop only)
// topic columns. Desktop drives the controller with page.mouse, the iPhone project with synthetic
// touch pointer events (pointerdown on the grip, 250 ms hold, pointermove on document, pointerup).
import { test, expect } from '@playwright/test';
import {
  altCard, buildWorkspace, drag, edgeOf, jokeCard, jokeIdsOn, mouseDrag, open, sampleWorkspace, seed, setItem, setOrder, showSet, topicCard, words,
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

  test('reordering the set never auto-scrolls the board beside the sidebar', async ({ page }) => {
    // Five topics make the board wider than the viewport; the set rows are dragged over the sidebar,
    // to the RIGHT of the board, which used to read as "near the board's right edge" and scroll it.
    const { ws, ids } = buildWorkspace((w, m) => {
      const jokes = [];
      for (let t = 1; t <= 5; t++) {
        const topic = m.addTopic(w, { title: `Topic ${t}` });
        jokes.push(m.addJoke(w, topic, { title: `Joke ${t}`, text: words(12) }));
      }
      jokes.forEach((id) => m.addToSet(w, id));
      return { jokes };
    });
    await seed(page, ws);
    await open(page);
    await showSet(page, false);
    const board = page.locator('.board');
    expect(await board.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const from = await setItem(page, ids.jokes[3]).getByTestId('set-grip').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8);
    const to = await edgeOf(setItem(page, ids.jokes[0]), 'top');
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.waitForTimeout(700); // auto-scroll runs per frame while the pointer is held still
    expect(await board.evaluate((el) => el.scrollLeft)).toBe(0);
    await page.mouse.up();
    expect(await setOrder(page)).toEqual([ids.jokes[3], ids.jokes[0], ids.jokes[1], ids.jokes[2], ids.jokes[4]]);
    expect(await board.evaluate((el) => el.scrollLeft)).toBe(0);
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

  test('the insertion indicator is not painted outside the column while auto-scrolling', async ({ page }) => {
    // Long jokes make the column scroll; the pointer parked at the column's bottom edge auto-scrolls
    // it, and the gap after the last card may lie below the scroller, over the tab bar.
    const { ws, ids } = buildWorkspace((w, m) => {
      const t = m.addTopic(w, { title: 'Long' });
      const first = m.addJoke(w, t, { title: 'First', text: words(60, 'a') });
      for (let i = 0; i < 3; i++) m.addJoke(w, t, { title: `J${i}`, text: words(60, `b${i}`) });
      return { first };
    });
    await seed(page, ws);
    await open(page);
    const grip = jokeCard(page, ids.first).getByTestId('joke-grip');
    const g = await grip.boundingBox();
    await grip.evaluate((el, opts) => el.dispatchEvent(new PointerEvent('pointerdown', opts)), touchInit(g.x + g.width / 2, g.y + g.height / 2));
    await page.waitForTimeout(250);
    const scroller = page.locator('.col-scroll').first();
    const sb = await scroller.boundingBox();
    const at = { x: sb.x + 150, y: sb.y + sb.height - 12 };
    await page.evaluate((opts) => document.dispatchEvent(new PointerEvent('pointermove', opts)), touchInit(at.x, at.y));
    await expect(page.locator('body')).toHaveClass(/is-dragging/);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(200); // auto-scroll ran
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)).toBe(true); // and reached the end
    const geometry = await page.evaluate(() => {
      const indicator = document.querySelector('.dnd-indicator');
      const s = document.querySelector('.col-scroll').getBoundingClientRect();
      const r = indicator.getBoundingClientRect();
      return { shown: indicator.style.display !== 'none', top: r.top, bottom: r.bottom, scrollerTop: s.top, scrollerBottom: s.bottom };
    });
    if (geometry.shown) {
      expect(geometry.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.scrollerTop - 2);
      expect(geometry.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.scrollerBottom + 2);
    }
    await page.evaluate((opts) => document.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })), touchInit(at.x, at.y));
    await expect(page.locator('body')).not.toHaveClass(/is-dragging/);
  });

  test('dropping above a first card whose top is scrolled away shows the indicator clamped to the column edge', async ({ page }) => {
    // A long first joke, scrolled so its top is clipped but its midpoint is still in view: the gap
    // above it is a valid drop (index 0), and the line used to disappear instead of marking it.
    const { ws, ids } = buildWorkspace((w, m) => {
      const parents = m.addTopic(w, { title: 'Parents' });
      const first = m.addJoke(w, parents, { title: 'First', text: words(120, 'a') });
      const second = m.addJoke(w, parents, { title: 'Second', text: words(20, 'b') });
      return { parents, first, second };
    });
    await seed(page, ws);
    await open(page);
    await jokeCard(page, ids.first).evaluate((card) => {
      const scroller = card.closest('.col-scroll');
      const c = card.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      scroller.scrollTop = c.top + c.height / 2 - s.top - 100; // midpoint 100 px below the column's top
    });
    const scroller = await page.locator('.col-scroll').first().boundingBox();
    expect((await jokeCard(page, ids.first).boundingBox()).y).toBeLessThan(scroller.y);
    const at = { x: scroller.x + 150, y: scroller.y + 60 }; // above the midpoint, outside the 40 px auto-scroll zone
    await beginDrag(page, true, jokeCard(page, ids.second).getByTestId('joke-grip'), at);
    const geometry = await page.evaluate(() => {
      const indicator = document.querySelector('.dnd-indicator');
      const r = indicator.getBoundingClientRect();
      const s = document.querySelector('.col-scroll').getBoundingClientRect();
      return { shown: indicator.style.display !== 'none', clamped: indicator.dataset.clamped, top: r.top, scrollerTop: s.top };
    });
    expect(geometry.shown, JSON.stringify(geometry)).toBe(true);
    expect(geometry.clamped).toBe('true');
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.scrollerTop - 1);
    expect(geometry.top).toBeLessThan(geometry.scrollerTop + 8);
    await endDrag(page, true, at);
    expect(await jokeIdsOn(topicCard(page, ids.parents))).toEqual([ids.second, ids.first]);
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
