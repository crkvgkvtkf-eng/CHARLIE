// Menus (SPEC §9.3, §12): the ⋯ buttons toggle their menu, keyboard focus survives re-renders
// while a menu is open, and focus returns to the opening button when an item is chosen or the
// menu is left with Tab (Escape is covered in board.spec.js).
import { test, expect } from '@playwright/test';
import { answerDialog, jokeCard, open, openMenu, sampleWorkspace, seed, topicCard } from './helpers.js';

test('clicking the ⋯ button or the version switcher again closes its menu', async ({ page }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const button = jokeCard(page, ids.security).getByTestId('joke-menu');
  const menu = await openMenu(page, button);
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  // The menu never covers its button (on a phone it fits neither below nor above a mid-screen card,
  // so it shrinks to the roomier side instead); otherwise the second tap would land on an item.
  const [menuBox, buttonBox] = await Promise.all([menu.boundingBox(), button.boundingBox()]);
  const overlaps = menuBox.y < buttonBox.y + buttonBox.height && menuBox.y + menuBox.height > buttonBox.y
    && menuBox.x < buttonBox.x + buttonBox.width && menuBox.x + menuBox.width > buttonBox.x;
  expect(overlaps, JSON.stringify({ menuBox, buttonBox })).toBe(false);
  await button.click();
  await expect(page.getByTestId('menu')).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'false');

  const switcher = page.getByTestId('version-switcher');
  await openMenu(page, switcher);
  await switcher.click();
  await expect(page.getByTestId('menu')).toHaveCount(0);
});

test.describe('keyboard', () => {
  test.skip(({ isMobile }) => isMobile, 'needs a hardware keyboard');

  test('arrow-key focus survives a re-render while the menu is open', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    const title = jokeCard(page, ids.security).getByTestId('joke-title');
    await title.fill('Security theatre'); // something to undo
    await title.blur();
    await openMenu(page, jokeCard(page, ids.security).getByTestId('joke-menu'));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const focused = page.getByTestId('menu').locator('[data-action="move-to-topic"]');
    await expect(focused).toBeFocused();
    // Undo from the keyboard changes the workspace and re-renders the card (and so the menu) underneath.
    await page.keyboard.press('Control+z');
    await expect(title).toHaveValue('Security line');
    await expect(page.getByTestId('menu')).toHaveCount(1);
    await expect(focused).toBeFocused();
  });

  test('choosing an item returns focus to the button, also after a cancelled confirm; so does Tab', async ({ page }) => {
    const { ws, ids } = sampleWorkspace();
    await seed(page, ws);
    await open(page);
    const topicButton = topicCard(page, ids.airports).getByTestId('topic-menu');
    await openMenu(page, topicButton);
    await page.getByTestId('menu').locator('[data-action="delete"]').click();
    await answerDialog(page, { confirm: false });
    await expect(topicButton).toBeFocused();
    await expect(page.getByTestId('topic-card')).toHaveCount(2);

    const jokeButton = jokeCard(page, ids.luggage).getByTestId('joke-menu');
    await openMenu(page, jokeButton);
    await page.getByTestId('menu').locator('[data-action="duplicate"]').click();
    await expect(page.getByTestId('menu')).toHaveCount(0);
    await expect(jokeButton).toBeFocused();

    await openMenu(page, jokeButton);
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('menu')).toHaveCount(0);
    await expect(jokeButton).toBeFocused();
  });
});
