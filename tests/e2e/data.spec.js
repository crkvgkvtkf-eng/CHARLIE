// Settings › Data (SPEC §6, §9.7): export produces the JSON envelope (never the sync config),
// import validates and offers Replace / Merge, and Reset all data double-confirms and wipes the device.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { serializeExport } from '../../js/storage.js';
import {
  SYNC_KEY, answerDialog, buildWorkspace, closeSettings, confirmDialog, open, openSettings, readStored, sampleWorkspace, seed, showSet, words,
} from './helpers.js';

/** A second workspace with a distinctive topic, as another device would export it. */
function importedWorkspace() {
  return buildWorkspace((w, m) => {
    const t = m.addTopic(w, { title: 'Imported topic' });
    const j = m.addJoke(w, t, { title: 'Imported joke', text: words(14, 'imp') });
    m.addToSet(w, j);
    m.renameVersion(w, w.activeVersionId, 'From the other device');
    return { t, j };
  });
}

async function chooseImportFile(settings, ws, name = 'other-device.json') {
  await settings.getByTestId('import-input').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(serializeExport(ws)) });
}

test('export downloads the JSON envelope without any sync configuration', async ({ page, isMobile }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  // A leftover token on the device must never leak into the export.
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ token: 'ghp_secret', login: 'me', gistId: 'g1', synced: {} })), SYNC_KEY);
  await open(page);
  const settings = await openSettings(page, isMobile);
  const [download] = await Promise.all([page.waitForEvent('download'), settings.getByTestId('export-button').click()]);
  expect(download.suggestedFilename()).toMatch(/^standup-set-builder-\d{4}-\d{2}-\d{2}\.json$/);
  const text = await readFile(await download.path(), 'utf8');
  expect(text).not.toContain('ghp_secret');
  const envelope = JSON.parse(text);
  expect(envelope.app).toBe('standup-set-builder');
  expect(typeof envelope.exportedAt).toBe('string');
  expect(envelope.workspace.versions[0].topics.map((t) => t.title)).toEqual(['Airports', 'Dating']);
  expect(envelope.workspace.versions[0].set.jokeIds).toEqual([ids.pretzels, ids.security]);
  expect(JSON.stringify(envelope)).not.toMatch(/token|ghp_/);
});

test('import › Replace swaps in the file and tombstones the old versions', async ({ page, isMobile }) => {
  const { ws } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const settings = await openSettings(page, isMobile);
  await expect(settings.getByTestId('import-replace')).toBeDisabled();
  await expect(settings.getByTestId('import-merge')).toBeDisabled();

  const { ws: other } = importedWorkspace();
  await chooseImportFile(settings, other);
  await expect(settings).toContainText('other-device.json');
  await settings.getByTestId('import-replace').click();
  await expect(confirmDialog(page)).toContainText('Replaces the data on all synced devices.');
  await answerDialog(page);
  await closeSettings(page, isMobile);

  await expect(page.getByTestId('topic-card')).toHaveCount(1);
  await expect(page.getByTestId('topic-title')).toHaveValue('Imported topic');
  await expect(page.getByTestId('version-switcher')).toHaveText(/From the other device/);
  await showSet(page, isMobile);
  await expect(page.getByTestId('set-item')).toHaveCount(1);

  const stored = await readStored(page);
  expect(stored.versions.map((v) => v.name)).toEqual(['From the other device']);
  expect(Object.keys(stored.tombstones)).toEqual([ws.versions[0].id]); // the replaced version is deleted everywhere on sync
  expect(stored.versions[0].updatedAt > other.versions[0].updatedAt).toBe(true); // stamped so the import wins a merge
  // Replace resets the undo history.
  await expect(page.getByTestId('undo')).toBeDisabled();
});

test('import › Merge keeps both workspaces as separate versions', async ({ page, isMobile }) => {
  const { ws } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const settings = await openSettings(page, isMobile);
  const { ws: other } = importedWorkspace();
  await chooseImportFile(settings, other);
  await settings.getByTestId('import-merge').click();
  await answerDialog(page);
  await expect(page.getByTestId('toast').filter({ hasText: 'Merged.' })).toBeVisible();
  await closeSettings(page, isMobile);

  // The active version is still ours; the imported one is available in the switcher.
  await expect(page.getByTestId('version-switcher')).toHaveText(/Set v1/);
  await expect(page.getByTestId('topic-card')).toHaveCount(2);
  await page.getByTestId('version-switcher').click();
  const items = page.getByTestId('menu').getByTestId('version-item');
  await expect(items).toHaveCount(2);
  await items.filter({ hasText: 'From the other device' }).click();
  await expect(page.getByTestId('topic-title')).toHaveValue('Imported topic');
  const stored = await readStored(page);
  expect(stored.versions).toHaveLength(2);
  expect(stored.tombstones).toEqual({});
});

test('a file that is not an export is rejected with a message and nothing changes', async ({ page, isMobile }) => {
  const { ws } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const settings = await openSettings(page, isMobile);
  await settings.getByTestId('import-input').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":"world"}') });
  await expect(page.getByTestId('toast')).toContainText('not a Stand-Up Set Builder export');
  await expect(settings.getByTestId('import-replace')).toBeDisabled();
  await settings.getByTestId('import-input').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
  await expect(page.getByTestId('toast').filter({ hasText: 'not valid JSON' })).toBeVisible();
  expect((await readStored(page)).versions[0].topics).toHaveLength(2);
});

test('reset all data double-confirms, empties the device and forgets the sync config', async ({ page, isMobile }) => {
  const { ws } = sampleWorkspace();
  await seed(page, ws);
  await page.addInitScript((key) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ token: null, login: null, gistId: null, synced: { abc: '2026-01-01T00:00:00.000Z' } }));
  }, SYNC_KEY);
  await open(page);
  const settings = await openSettings(page, isMobile);
  await settings.getByTestId('reset-button').click();
  await expect(confirmDialog(page)).toContainText('This device only; your gist and other devices are not changed. Sync will be disconnected.');
  await answerDialog(page);
  // The second confirm can still be cancelled.
  await answerDialog(page, { confirm: false });
  await closeSettings(page, isMobile);
  await expect(page.getByTestId('topic-card')).toHaveCount(2);

  await openSettings(page, isMobile);
  await page.getByTestId('reset-button').click();
  await answerDialog(page);
  await answerDialog(page);
  await closeSettings(page, isMobile);
  await expect(page.getByTestId('empty-board')).toBeVisible();
  await expect(page.getByTestId('version-switcher')).toHaveText(/Set v1/);
  await expect(page.getByTestId('sync-dot')).toHaveAttribute('data-state', 'off');
  expect(await page.evaluate((key) => localStorage.getItem(key), SYNC_KEY)).toBeNull();
  expect((await readStored(page)).versions[0].topics).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('empty-board')).toBeVisible();
});
