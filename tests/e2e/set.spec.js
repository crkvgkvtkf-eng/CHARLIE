// Set panel / Set tab (SPEC §9.5): in-set toggling, set order independent of board order, badges,
// remove, reveal-on-board, footer totals / target / delta / bar, empty state, the desktop sidebar
// collapse and the live Set tab label on the iPhone project.
import { test, expect } from '@playwright/test';
import { formatDuration } from '../../js/timing.js';
import {
  DEFAULTS, buildWorkspace, jokeCard, open, readStored, sampleWorkspace, secondsFor, seed, setItem, setOrder, showBoard, showSet, words,
} from './helpers.js';

test('ticking jokes builds the set in tick order with badges, totals and the live tab label', async ({ page, isMobile }) => {
  const { ws, ids } = buildWorkspace((w, m) => {
    const t = m.addTopic(w, { title: 'Airports' });
    return {
      a: m.addJoke(w, t, { title: 'A', text: words(14) }),
      b: m.addJoke(w, t, { title: 'B', text: words(28) }),
      c: m.addJoke(w, t, { title: 'C', text: words(7) }),
    };
  });
  await seed(page, ws);
  await open(page);

  await jokeCard(page, ids.c).getByTestId('joke-inset').check();
  await jokeCard(page, ids.a).getByTestId('joke-inset').check();
  await expect(jokeCard(page, ids.c).getByTestId('joke-badge')).toHaveText('#1');
  await expect(jokeCard(page, ids.a).getByTestId('joke-badge')).toHaveText('#2');
  await expect(jokeCard(page, ids.b).getByTestId('joke-badge')).toHaveCount(0);
  await expect(page.getByTestId('topic-chip')).toHaveText(`2/3 in set · ${formatDuration(secondsFor(words(7)) + secondsFor(words(14)))}`);

  const total = secondsFor(words(7)) + secondsFor(words(14));
  if (isMobile) await expect(page.getByTestId('tab-set')).toContainText(`Set · ${formatDuration(total)}`);
  await showSet(page, isMobile);
  expect(await setOrder(page)).toEqual([ids.c, ids.a]);
  await expect(page.getByTestId('set-panel')).toContainText('2 jokes');
  await expect(page.getByTestId('set-total')).toHaveText(formatDuration(total));
  await expect(page.getByTestId('set-words')).toHaveText('21 words');
  await expect(setItem(page, ids.c).getByTestId('set-time')).toHaveText(formatDuration(secondsFor(words(7))));
  await expect(setItem(page, ids.c).getByTestId('set-title')).toContainText('C');
  await expect(setItem(page, ids.c).getByTestId('set-title')).toContainText('Airports');

  // Remove from the list: the board checkbox follows and the remaining joke becomes #1.
  await setItem(page, ids.c).getByTestId('set-remove').click();
  expect(await setOrder(page)).toEqual([ids.a]);
  await showBoard(page, isMobile);
  await expect(jokeCard(page, ids.c).getByTestId('joke-inset')).not.toBeChecked();
  await expect(jokeCard(page, ids.a).getByTestId('joke-badge')).toHaveText('#1');

  // Unticking on the board empties the set.
  await jokeCard(page, ids.a).getByTestId('joke-inset').uncheck();
  if (isMobile) await expect(page.getByTestId('tab-set')).toContainText('Set · 0:00');
  await showSet(page, isMobile);
  await expect(page.getByTestId('set-item')).toHaveCount(0);
  await expect(page.getByTestId('set-panel')).toContainText("Tick 'In set' on a joke to build your set.");
  await expect(page.getByTestId('set-total')).toHaveText('0:00');
});

test('footer shows target, delta and bar state as the set grows', async ({ page, isMobile }) => {
  // 30 s target so a handful of short jokes crosses it.
  const { ws, ids } = buildWorkspace((w, m) => {
    m.updateSettings(w, { targetSec: 30 });
    const t = m.addTopic(w, { title: 'T' });
    return {
      short: m.addJoke(w, t, { title: 'Short', text: words(14) }), // 8 s
      long: m.addJoke(w, t, { title: 'Long', text: words(49) }), // 23 s
      extra: m.addJoke(w, t, { title: 'Extra', text: words(35) }), // 17 s
    };
  });
  await seed(page, ws);
  await open(page);
  await showSet(page, isMobile);
  await expect(page.getByTestId('set-target')).toHaveText('0:30');
  await expect(page.getByTestId('set-delta')).toHaveText('−0:30 under');
  await expect(page.getByTestId('set-bar')).toHaveAttribute('data-state', 'neutral');
  await expect(page.getByTestId('set-bar')).toHaveAttribute('aria-valuenow', '0');

  await showBoard(page, isMobile);
  await jokeCard(page, ids.short).getByTestId('joke-inset').check(); // 8 s → under
  await jokeCard(page, ids.long).getByTestId('joke-inset').check(); // 31 s → on target, green bar
  await showSet(page, isMobile);
  await expect(page.getByTestId('set-total')).toHaveText('0:31');
  await expect(page.getByTestId('set-delta')).toHaveText('on target');
  await expect(page.getByTestId('set-bar')).toHaveAttribute('data-state', 'ok');
  if (isMobile) await expect(page.getByTestId('tab-set').locator('.tab-time')).toHaveClass(/ok/);

  await showBoard(page, isMobile);
  await jokeCard(page, ids.extra).getByTestId('joke-inset').check(); // 48 s → over, red bar
  await showSet(page, isMobile);
  await expect(page.getByTestId('set-total')).toHaveText('0:48');
  await expect(page.getByTestId('set-delta')).toHaveText('+0:18 over');
  await expect(page.getByTestId('set-delta')).toHaveClass(/over/);
  await expect(page.getByTestId('set-bar')).toHaveAttribute('data-state', 'over');
  await expect(page.getByTestId('set-bar')).toHaveAttribute('aria-valuenow', '100');
  if (isMobile) await expect(page.getByTestId('tab-set').locator('.tab-time')).toHaveClass(/over/);
});

test('clicking a set row reveals the joke on the board with a flash', async ({ page, isMobile }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  await showSet(page, isMobile);
  await setItem(page, ids.security).getByTestId('set-title').click();
  const card = jokeCard(page, ids.security);
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/flash/);
  if (isMobile) await expect(page.getByTestId('tab-board')).toHaveAttribute('aria-current', 'page');
  await expect(card).toBeInViewport();
});

test('set order is independent of board position and survives a reload', async ({ page, isMobile }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  await showSet(page, isMobile);
  expect(await setOrder(page)).toEqual([ids.pretzels, ids.security]);
  await page.reload();
  await showSet(page, isMobile);
  expect(await setOrder(page)).toEqual([ids.pretzels, ids.security]);
  const stored = await readStored(page);
  expect(stored.versions[0].set.jokeIds).toEqual([ids.pretzels, ids.security]);
  expect(stored.settings.targetSec).toBe(DEFAULTS.targetSec);
});

test('desktop sidebar collapses to a rail and remembers it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the sidebar toggle exists on desktop only');
  const { ws } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const panel = page.getByTestId('set-panel');
  await expect(panel).toHaveAttribute('data-collapsed', 'false');
  await page.getByTestId('set-toggle').click();
  await expect(panel).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('set-item')).toHaveCount(0);
  await expect(panel).toContainText(formatDuration(secondsFor(words(42)) + secondsFor(words(28))));
  expect(await page.evaluate(() => localStorage.getItem('ssb.ui.setCollapsed'))).toBe('true');
  await page.reload();
  await expect(page.getByTestId('set-panel')).toHaveAttribute('data-collapsed', 'true');
  await page.getByTestId('set-toggle').click();
  await expect(page.getByTestId('set-panel')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('set-item')).toHaveCount(2);
});
