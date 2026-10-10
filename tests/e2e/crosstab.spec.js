// Two tabs (or windows) of the same origin (SPEC §12: the app never silently loses user text).
// Each tab keeps its own in-memory workspace; an edit persisted by one must reach the other through
// the `storage` event instead of being overwritten wholesale by the other tab's next save.
import { test, expect } from '@playwright/test';
import { STORAGE_KEY, jokeCard, open, sampleWorkspace, seed } from './helpers.js';

test('edits made in two tabs are both kept, shown in both, and undo stays per tab', async ({ context, page }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(context, ws);
  const other = await context.newPage();
  await open(page);
  await open(other);

  await jokeCard(page, ids.security).getByTestId('joke-title').fill('Security edited in tab A');
  await expect(jokeCard(other, ids.security).getByTestId('joke-title')).toHaveValue('Security edited in tab A');

  await jokeCard(other, ids.luggage).getByTestId('joke-title').fill('Luggage edited in tab B');
  await expect(jokeCard(page, ids.luggage).getByTestId('joke-title')).toHaveValue('Luggage edited in tab B');
  await expect(jokeCard(page, ids.security).getByTestId('joke-title')).toHaveValue('Security edited in tab A'); // not overwritten by B's save

  const stored = JSON.parse(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY));
  expect(stored.versions[0].topics[0].jokes.map((j) => j.title)).toEqual(['Security edited in tab A', 'Luggage edited in tab B', 'Tiny pretzels']);
  expect(stored.versions).toHaveLength(1); // no conflict copy for edits that never overlapped

  // Undo in tab B takes back only tab B's own edit, and tab A follows.
  await other.getByTestId('undo').click();
  await expect(jokeCard(other, ids.luggage).getByTestId('joke-title')).toHaveValue('Lost luggage');
  await expect(jokeCard(other, ids.security).getByTestId('joke-title')).toHaveValue('Security edited in tab A');
  await expect(jokeCard(page, ids.luggage).getByTestId('joke-title')).toHaveValue('Lost luggage');
});
