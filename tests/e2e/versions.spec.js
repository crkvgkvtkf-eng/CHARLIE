// Versions (SPEC §9.6): the top-bar switcher, the New version dialog (copy / blank), switching,
// and the Manage dialog (rename inline, duplicate, delete with confirm, refused for the only version).
import { test, expect } from '@playwright/test';
import { answerDialog, open, readStored, sampleWorkspace, seed, showSet } from './helpers.js';

async function openSwitcher(page) {
  await page.getByTestId('version-switcher').click();
  const menu = page.getByTestId('menu');
  await expect(menu).toBeVisible();
  return menu;
}

async function openManage(page) {
  await openSwitcher(page);
  await page.getByTestId('version-manage').click();
  const dialog = page.getByTestId('version-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('new version from the current one copies the board and the set; blank starts empty', async ({ page, isMobile }) => {
  const { ws } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  await expect(page.getByTestId('version-switcher')).toHaveText(/Set v1/);

  await openSwitcher(page);
  await page.getByTestId('version-new').click();
  const dialog = page.getByTestId('new-version-dialog');
  await expect(dialog.getByTestId('new-version-name')).toHaveValue('Set v1 copy');
  await expect(dialog.getByTestId('new-version-from')).toHaveValue('current');
  await dialog.getByTestId('new-version-name').fill('Club night');
  await dialog.getByTestId('new-version-create').click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByTestId('version-switcher')).toHaveText(/Club night/);
  await expect(page.getByTestId('topic-card')).toHaveCount(2);
  await expect(page.getByTestId('joke-card')).toHaveCount(5);
  await showSet(page, isMobile);
  await expect(page.getByTestId('set-item')).toHaveCount(2);
  const stored = await readStored(page);
  expect(stored.versions).toHaveLength(2);
  const copy = stored.versions.find((v) => v.name === 'Club night');
  const original = stored.versions.find((v) => v.name === 'Set v1');
  expect(stored.activeVersionId).toBe(copy.id);
  // Fresh ids everywhere: editing the copy can never touch the original.
  const idsOf = (v) => v.topics.flatMap((t) => [t.id, ...t.jokes.flatMap((j) => [j.id, ...j.alts.map((a) => a.id)])]);
  expect(idsOf(copy).some((id) => idsOf(original).includes(id))).toBe(false);
  expect(copy.set.jokeIds.every((id) => idsOf(copy).includes(id))).toBe(true);

  if (isMobile) await page.getByTestId('tab-board').click();
  await openSwitcher(page);
  await page.getByTestId('version-new').click();
  await page.getByTestId('new-version-from').selectOption('blank');
  await expect(page.getByTestId('new-version-name')).toHaveValue('Set v3');
  await page.getByTestId('new-version-create').click();
  await expect(page.getByTestId('version-switcher')).toHaveText(/Set v3/);
  await expect(page.getByTestId('empty-board')).toBeVisible();
});

test('switching through the menu shows the chosen version and marks it', async ({ page }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const dialog = await openManage(page);
  await dialog.getByTestId('version-new-blank').click();
  await expect(dialog.getByTestId('version-row')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('empty-board')).toBeVisible();

  const menu = await openSwitcher(page);
  const items = menu.getByTestId('version-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toHaveAttribute('aria-checked', 'true');
  await items.nth(0).click();
  await expect(page.getByTestId('version-switcher')).toHaveText(/Set v1/);
  await expect(page.locator(`[data-testid="topic-card"][data-id="${ids.airports}"]`)).toBeVisible();
  await expect(page.getByTestId('empty-board')).toHaveCount(0);
  const stored = await readStored(page);
  expect(stored.activeVersionId).toBe(ws.versions[0].id);
});

test('manage dialog: rename inline, duplicate, delete with confirm; the only version cannot be deleted', async ({ page }) => {
  const { ws } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const dialog = await openManage(page);
  const rows = dialog.getByTestId('version-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('2 topics · 5 jokes · 2 in set');
  await expect(rows.first().getByTestId('version-delete')).toBeDisabled();

  // Rename: the input appears focused with the name selected; Enter commits.
  await rows.first().getByTestId('version-rename').click();
  const input = rows.first().locator('input');
  await expect(input).toBeFocused();
  await input.fill('Open mic');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(rows.first()).toContainText('Open mic');
  await expect(page.getByTestId('version-switcher')).toHaveText(/Open mic/);

  // Duplicate: a second row named "<name> copy" becomes active.
  await rows.first().getByTestId('version-duplicate').click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('Open mic copy');
  await expect(rows.nth(1)).toHaveClass(/active/);
  await expect(rows.nth(1)).toContainText('5 jokes');
  await expect(rows.first().getByTestId('version-delete')).toBeEnabled();

  // Delete the active copy: cancel keeps it, confirm removes it and the original is active again.
  await rows.nth(1).getByTestId('version-delete').click();
  await answerDialog(page, { confirm: false });
  await expect(rows).toHaveCount(2);
  await rows.nth(1).getByTestId('version-delete').click();
  await answerDialog(page);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveClass(/active/);
  await expect(rows.first().getByTestId('version-delete')).toBeDisabled();
  await expect(page.getByTestId('version-switcher')).toHaveText(/Open mic/);

  const stored = await readStored(page);
  expect(stored.versions).toHaveLength(1);
  expect(Object.keys(stored.tombstones)).toHaveLength(1); // the deleted copy left a tombstone for sync

  // Undo brings the deleted version back.
  await page.keyboard.press('Escape');
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('version-switcher')).toHaveText(/Open mic copy/);
});

test('the mobile More view opens the manage dialog', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'More view exists on the iPhone project only');
  await open(page);
  await page.getByTestId('tab-more').click();
  await page.locator('.more-versions').click();
  await expect(page.getByTestId('version-dialog')).toBeVisible();
  await expect(page.getByTestId('version-row')).toHaveCount(1);
});
