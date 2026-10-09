// Undo / redo (SPEC §5, §8, §9.3): toolbar buttons on both projects, typing coalesced into one
// entry, redo cleared by a new change, undoing a version switch, and keyboard shortcuts on desktop.
import { test, expect } from '@playwright/test';
import { jokeCard, open, sampleWorkspace, seed, showBoard, showSet, topicCard } from './helpers.js';

test('toolbar undo / redo walk the history of structural changes', async ({ page, isMobile }) => {
  await open(page);
  const undo = page.getByTestId('undo');
  const redo = page.getByTestId('redo');
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  await page.getByTestId('add-topic').click();
  await page.getByTestId('add-joke').click();
  await page.getByTestId('joke-inset').check();
  await expect(undo).toBeEnabled();

  await undo.click(); // in set
  await expect(page.getByTestId('joke-inset')).not.toBeChecked();
  await expect(redo).toBeEnabled();
  await undo.click(); // joke
  await expect(page.getByTestId('joke-card')).toHaveCount(0);
  await undo.click(); // topic
  await expect(page.getByTestId('empty-board')).toBeVisible();
  await expect(undo).toBeDisabled();

  await redo.click();
  await expect(page.getByTestId('topic-card')).toHaveCount(1);
  await redo.click();
  await redo.click();
  await expect(page.getByTestId('joke-inset')).toBeChecked();
  await expect(redo).toBeDisabled();
  if (isMobile) await expect(page.getByTestId('tab-set')).toContainText('Set · 0:02');

  // A new change after an undo discards the redo branch.
  await undo.click();
  await expect(redo).toBeEnabled();
  await page.getByTestId('add-joke').click();
  await expect(redo).toBeDisabled();
  await showSet(page, isMobile);
  await expect(page.getByTestId('set-item')).toHaveCount(0);
  await showBoard(page, isMobile);
});

test('a typing run is one undo step; a pause or blur starts a new one', async ({ page }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const title = jokeCard(page, ids.luggage).getByTestId('joke-title');
  const undo = page.getByTestId('undo');
  await expect(undo).toBeDisabled();

  await title.click();
  await title.pressSequentially(' overhead');
  await expect(title).toHaveValue('Lost luggage overhead');
  await title.blur(); // ends the coalescing run
  await title.click();
  await title.pressSequentially(' bin');
  await expect(title).toHaveValue('Lost luggage overhead bin');
  await title.blur();

  await undo.click();
  await expect(title).toHaveValue('Lost luggage overhead');
  await undo.click();
  await expect(title).toHaveValue('Lost luggage');
  await expect(undo).toBeDisabled();
  await page.getByTestId('redo').click();
  await expect(title).toHaveValue('Lost luggage overhead');
});

test('undo restores a removed topic together with its set membership', async ({ page, isMobile }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const airports = topicCard(page, ids.airports);
  await airports.getByTestId('topic-menu').click();
  await page.getByTestId('menu').locator('[data-action="delete"]').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('topic-card')).toHaveCount(1);
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('topic-card')).toHaveCount(2);
  await expect(jokeCard(page, ids.pretzels).getByTestId('joke-badge')).toHaveText('#1');
  await expect(jokeCard(page, ids.security).getByTestId('joke-badge')).toHaveText('#2');
  await showSet(page, isMobile);
  await expect(page.getByTestId('set-item')).toHaveCount(2);
});

test('switching versions is undoable', async ({ page }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  await page.getByTestId('version-switcher').click();
  await page.getByTestId('version-new').click();
  await page.getByTestId('new-version-from').selectOption('blank');
  await page.getByTestId('new-version-create').click();
  await expect(page.getByTestId('version-switcher')).toHaveText(/Set v2/);
  await expect(page.getByTestId('empty-board')).toBeVisible();

  await page.getByTestId('undo').click();
  await expect(page.getByTestId('version-switcher')).toHaveText(/Set v1/);
  await expect(topicCard(page, ids.airports)).toBeVisible();
  await page.getByTestId('redo').click();
  await expect(page.getByTestId('version-switcher')).toHaveText(/Set v2/);

  // Switch back through the menu, then undo that switch.
  await page.getByTestId('version-switcher').click();
  await page.getByTestId('menu').locator('[data-testid="version-item"]').first().click();
  await expect(page.getByTestId('version-switcher')).toHaveText(/Set v1/);
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('version-switcher')).toHaveText(/Set v2/);
  await expect(page.getByTestId('empty-board')).toBeVisible();
});

test('keyboard shortcuts undo and redo outside text fields', async ({ page, isMobile }) => {
  test.skip(isMobile, 'hardware keyboard shortcuts are a desktop feature');
  await open(page);
  await page.getByTestId('add-topic').click();
  const title = page.getByTestId('topic-title');
  await title.fill('Airports');

  // Inside a text field the shortcut is left to the browser's native undo of the field.
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('topic-card')).toHaveCount(1);

  await title.blur();
  await page.keyboard.press('Control+z'); // title text
  await expect(title).toHaveValue('');
  await page.keyboard.press('Control+z'); // topic
  await expect(page.getByTestId('empty-board')).toBeVisible();
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByTestId('topic-card')).toHaveCount(1);
  await page.keyboard.press('Control+y');
  await expect(page.getByTestId('topic-title')).toHaveValue('Airports');
});
