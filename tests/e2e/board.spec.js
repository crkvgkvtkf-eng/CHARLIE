// Board (SPEC §9.3): topic / joke / alt creation, card menus (rename, colour, collapse, move,
// duplicate, delete, manual time, promote, move-to), keyboard behaviour and the empty state.
import { test, expect } from '@playwright/test';
import { formatDuration } from '../../js/timing.js';
import {
  altCard, answerDialog, chooseFromMenu, chipText, jokeCard, jokeIdsOn, open, openMenu, pickMenuItem,
  readStored, sampleWorkspace, secondsFor, seed, topicCard, words,
} from './helpers.js';

test.describe('creating cards', () => {
  test('topic, joke and alt are created in order and focused', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('empty-board')).toBeVisible();

    await page.getByTestId('add-topic').click();
    await expect(page.getByTestId('empty-board')).toHaveCount(0);
    await expect(page.getByTestId('topic-title')).toBeFocused();
    await page.getByTestId('topic-title').fill('Airports');

    await page.getByTestId('add-joke').click();
    await expect(page.getByTestId('joke-title')).toBeFocused();
    await page.getByTestId('joke-title').fill('Security');
    await page.getByTestId('joke-text').fill(words(14));
    await expect(page.getByTestId('joke-time')).toHaveText(chipText(words(14)));

    // A second joke goes to the end of the column.
    await page.getByTestId('add-joke').click();
    await expect(page.getByTestId('joke-card')).toHaveCount(2);
    await expect(page.getByTestId('joke-card').nth(1).getByTestId('joke-title')).toBeFocused();
    await page.getByTestId('joke-card').nth(1).getByTestId('joke-title').fill('Luggage');

    // Alts hang under their joke; the "Use original" radio appears once a joke has alts.
    const first = page.getByTestId('joke-card').nth(0);
    await expect(first.getByTestId('use-original')).toHaveCount(0);
    await first.getByTestId('add-alt').click();
    await expect(first.getByTestId('alt-card')).toHaveCount(1);
    await expect(first.getByTestId('alt-text')).toBeFocused();
    await expect(first.getByTestId('use-original')).toBeChecked();

    const stored = await readStored(page);
    const topic = stored.versions[0].topics[0];
    expect(topic.title).toBe('Airports');
    expect(topic.jokes.map((j) => j.title)).toEqual(['Security', 'Luggage']);
    expect(topic.jokes[0].alts).toHaveLength(1);
  });

  test('Enter in a title moves focus to the joke text', async ({ page }) => {
    const { ws } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    const card = page.getByTestId('joke-card').first();
    await card.getByTestId('joke-title').click();
    await page.keyboard.press('Enter');
    await expect(card.getByTestId('joke-text')).toBeFocused();
    // Enter in a topic title lands on its first joke title.
    await page.getByTestId('topic-title').first().click();
    await page.keyboard.press('Enter');
    await expect(card.getByTestId('joke-title')).toBeFocused();
  });

  test('a second "+ Topic" button sits after the last column', async ({ page }) => {
    const { ws } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    await expect(page.getByTestId('topic-card')).toHaveCount(2);
    await page.getByTestId('add-topic').last().scrollIntoViewIfNeeded();
    await page.getByTestId('add-topic').last().click();
    await expect(page.getByTestId('topic-card')).toHaveCount(3);
    await expect(page.getByTestId('topic-card').nth(2).getByTestId('topic-title')).toBeFocused();
  });
});

test.describe('topic menu', () => {
  test('rename focuses the title, colour tints the column, delete asks and removes jokes from the set', async ({ page, isMobile }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    const airports = topicCard(page, ids.airports);

    await chooseFromMenu(page, airports.getByTestId('topic-menu'), 'rename');
    await expect(airports.getByTestId('topic-title')).toBeFocused();

    await chooseFromMenu(page, airports.getByTestId('topic-menu'), 'color-rose');
    await expect(airports).toHaveAttribute('data-color', 'rose');
    await chooseFromMenu(page, airports.getByTestId('topic-menu'), 'color-none');
    await expect(airports).not.toHaveAttribute('data-color', /./);

    // Delete: the confirm names the joke count; cancelling keeps everything.
    await chooseFromMenu(page, airports.getByTestId('topic-menu'), 'delete');
    await expect(page.getByTestId('dialog')).toContainText('3 jokes');
    await answerDialog(page, { confirm: false });
    await expect(page.getByTestId('topic-card')).toHaveCount(2);

    await chooseFromMenu(page, airports.getByTestId('topic-menu'), 'delete');
    await answerDialog(page);
    await expect(page.getByTestId('topic-card')).toHaveCount(1);
    await expect(page.getByTestId('topic-title')).toHaveValue('Dating');
    if (isMobile) await expect(page.getByTestId('tab-set')).toContainText('Set · 0:00');
    const stored = await readStored(page);
    expect(stored.versions[0].set.jokeIds).toEqual([]);
  });

  test('move left / right reorders columns; the edge items are disabled', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    const airports = topicCard(page, ids.airports);
    const menu = await openMenu(page, airports.getByTestId('topic-menu'));
    await expect(menu.locator('[data-action="move-left"]')).toBeDisabled();
    await pickMenuItem(page, 'move-right');
    await expect(page.getByTestId('topic-card').nth(0)).toHaveAttribute('data-id', ids.dating);
    await expect(page.getByTestId('topic-card').nth(1)).toHaveAttribute('data-id', ids.airports);
    await chooseFromMenu(page, airports.getByTestId('topic-menu'), 'move-left');
    await expect(page.getByTestId('topic-card').nth(0)).toHaveAttribute('data-id', ids.airports);
  });

  test('collapse hides jokes per device and survives a reload', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    const airports = topicCard(page, ids.airports);
    await expect(airports.getByTestId('joke-card')).toHaveCount(3);
    await chooseFromMenu(page, airports.getByTestId('topic-menu'), 'collapse');
    await expect(airports.getByTestId('joke-card')).toHaveCount(0);
    await expect(airports).toContainText('3 jokes hidden');
    // The chip still counts the hidden jokes and the workspace is untouched.
    await expect(airports.getByTestId('topic-chip')).toContainText('2/3 in set');
    expect((await readStored(page)).versions[0].topics[0].jokes).toHaveLength(3);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ssb.ui.collapsed')))).toEqual([ids.airports]);

    await page.reload();
    await expect(topicCard(page, ids.airports).getByTestId('joke-card')).toHaveCount(0);
    await chooseFromMenu(page, topicCard(page, ids.airports).getByTestId('topic-menu'), 'collapse');
    await expect(topicCard(page, ids.airports).getByTestId('joke-card')).toHaveCount(3);
  });
});

test.describe('joke menu', () => {
  test('move up / down and move to another topic', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    const airports = topicCard(page, ids.airports);
    const dating = topicCard(page, ids.dating);

    await chooseFromMenu(page, jokeCard(page, ids.pretzels).getByTestId('joke-menu'), 'move-up');
    expect(await jokeIdsOn(airports)).toEqual([ids.security, ids.pretzels, ids.luggage]);
    await chooseFromMenu(page, jokeCard(page, ids.security).getByTestId('joke-menu'), 'move-down');
    expect(await jokeIdsOn(airports)).toEqual([ids.pretzels, ids.security, ids.luggage]);

    await chooseFromMenu(page, jokeCard(page, ids.luggage).getByTestId('joke-menu'), 'move-to-topic', ids.dating);
    expect(await jokeIdsOn(airports)).toEqual([ids.pretzels, ids.security]);
    expect(await jokeIdsOn(dating)).toEqual([ids.apps, ids.firstDate, ids.luggage]);
    await expect(airports.getByTestId('topic-chip')).toContainText('2/2 in set');
  });

  test('duplicate copies the joke (with alts) right after it, out of the set', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    const dating = topicCard(page, ids.dating);
    await chooseFromMenu(page, jokeCard(page, ids.apps).getByTestId('joke-menu'), 'duplicate');
    await expect(dating.getByTestId('joke-card')).toHaveCount(3);
    const copy = dating.getByTestId('joke-card').nth(1);
    await expect(copy).not.toHaveAttribute('data-id', ids.apps);
    await expect(copy.getByTestId('joke-title')).toHaveValue('Apps');
    await expect(copy.getByTestId('alt-card')).toHaveCount(2);
    await expect(copy.getByTestId('joke-inset')).not.toBeChecked();

    // In-set state is per joke: ticking the original leaves the copy alone.
    await jokeCard(page, ids.apps).getByTestId('joke-inset').check();
    await expect(copy).not.toHaveClass(/in-set/);
  });

  test('manual time overrides the estimate and a blank prompt clears it', async ({ page, isMobile }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    const card = jokeCard(page, ids.pretzels);
    const text = ws.versions[0].topics[0].jokes[2].text;
    await expect(card.getByTestId('joke-time')).toHaveText(chipText(text));

    await chooseFromMenu(page, card.getByTestId('joke-menu'), 'manual-time');
    await answerDialog(page, { text: '1:30' });
    await expect(card.getByTestId('joke-time')).toContainText('1:30');
    await expect(card.getByTestId('joke-time')).toHaveAttribute('title', 'Manual time');
    // The set holds pretzels (now 90 s) and "Security line" (estimated).
    if (isMobile) await expect(page.getByTestId('tab-set')).toContainText(`Set · ${formatDuration(90 + secondsFor(ws.versions[0].topics[0].jokes[0].text))}`);

    // Garbage is rejected with a toast and leaves the override alone.
    await chooseFromMenu(page, card.getByTestId('joke-menu'), 'manual-time');
    await answerDialog(page, { text: 'soon' });
    await expect(page.getByTestId('toast')).toContainText('Enter a time');
    await expect(card.getByTestId('joke-time')).toContainText('1:30');

    await chooseFromMenu(page, card.getByTestId('joke-menu'), 'manual-time');
    await answerDialog(page, { text: '' });
    await expect(card.getByTestId('joke-time')).toHaveText(chipText(text));
    await expect(card.getByTestId('joke-time')).not.toHaveAttribute('title', /./);
  });

  test('delete asks only when the joke has text', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    await chooseFromMenu(page, jokeCard(page, ids.security).getByTestId('joke-menu'), 'delete');
    await expect(page.getByTestId('dialog')).toContainText('Security line');
    await answerDialog(page, { confirm: false });
    await expect(jokeCard(page, ids.security)).toHaveCount(1);
    await chooseFromMenu(page, jokeCard(page, ids.security).getByTestId('joke-menu'), 'delete');
    await answerDialog(page);
    await expect(jokeCard(page, ids.security)).toHaveCount(0);
    await expect(topicCard(page, ids.airports).getByTestId('topic-chip')).toContainText('1/2 in set');

    // An empty joke goes without a dialog.
    await topicCard(page, ids.dating).getByTestId('add-joke').click();
    const blank = topicCard(page, ids.dating).getByTestId('joke-card').nth(2);
    await chooseFromMenu(page, blank.getByTestId('joke-menu'), 'delete');
    await expect(page.getByTestId('dialog')).toHaveCount(0);
    await expect(topicCard(page, ids.dating).getByTestId('joke-card')).toHaveCount(2);
  });
});

test.describe('alt cards', () => {
  test('use this / use original switch the delivered text', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    const apps = jokeCard(page, ids.apps);
    const joke = ws.versions[0].topics[1].jokes[0];
    await expect(apps.getByTestId('joke-time')).toHaveText(chipText(joke.text));
    await altCard(page, ids.altB).getByTestId('alt-use').check();
    await expect(apps.getByTestId('joke-time')).toHaveText(chipText(joke.alts[1].text));
    await expect(apps.getByTestId('use-original')).not.toBeChecked();
    await apps.getByTestId('use-original').check();
    await expect(apps.getByTestId('joke-time')).toHaveText(chipText(joke.text));
    await expect(altCard(page, ids.altB).getByTestId('alt-use')).not.toBeChecked();
  });

  test('promote swaps the alt with the joke text; move up/down, move to joke and delete', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    const apps = jokeCard(page, ids.apps);
    const joke = ws.versions[0].topics[1].jokes[0];

    await altCard(page, ids.altA).getByTestId('alt-use').check();
    await chooseFromMenu(page, altCard(page, ids.altA).getByTestId('alt-menu'), 'promote');
    await expect(apps.getByTestId('joke-text')).toHaveValue(joke.alts[0].text);
    await expect(altCard(page, ids.altA).getByTestId('alt-text')).toHaveValue(joke.text);
    await expect(apps.getByTestId('use-original')).toBeChecked();

    await chooseFromMenu(page, altCard(page, ids.altB).getByTestId('alt-menu'), 'move-up');
    await expect(apps.getByTestId('alt-card').nth(0)).toHaveAttribute('data-id', ids.altB);
    await chooseFromMenu(page, altCard(page, ids.altB).getByTestId('alt-menu'), 'move-down');
    await expect(apps.getByTestId('alt-card').nth(1)).toHaveAttribute('data-id', ids.altB);

    await chooseFromMenu(page, altCard(page, ids.altB).getByTestId('alt-menu'), 'move-to-joke', ids.firstDate);
    await expect(apps.getByTestId('alt-card')).toHaveCount(1);
    await expect(jokeCard(page, ids.firstDate).getByTestId('alt-card')).toHaveCount(1);
    await expect(jokeCard(page, ids.firstDate).getByTestId('use-original')).toBeChecked();

    await chooseFromMenu(page, altCard(page, ids.altA).getByTestId('alt-menu'), 'delete');
    await expect(apps.getByTestId('alt-card')).toHaveCount(0);
    await expect(apps.getByTestId('use-original')).toHaveCount(0);
  });
});

test('Escape closes an open menu and returns focus to its button', async ({ page }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const button = jokeCard(page, ids.apps).getByTestId('joke-menu');
  await openMenu(page, button);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('menu')).toHaveCount(0);
  await expect(button).toBeFocused();
});
