// Sync (SPEC §7, §9.7, §13.1): two browser contexts ("devices") talk to one in-memory fake of the
// GitHub gist API. Contexts block service workers so page.route sees every api.github.com call.
import { test, expect } from '@playwright/test';
import { GIST_FILENAME } from '../../js/sync.js';
import { createFakeGithub, install } from './fakeGithub.js';
import { closeSettings, jokeCard, open, openSettings, sampleWorkspace, seed } from './helpers.js';

const TOKEN = 'ghp_e2e_token';

/** A fresh "device": its own context (service workers blocked) routed through the shared fake. */
async function newDevice(browser, contextOptions, fake, ws = null) {
  const context = await browser.newContext({ ...contextOptions, serviceWorkers: 'block' });
  await install(context, fake);
  if (ws) await seed(context, ws);
  const page = await context.newPage();
  return { context, page };
}

/** Connects a page through Settings › Sync and waits for the connected state. */
async function connect(page, isMobile, token = TOKEN) {
  const settings = await openSettings(page, isMobile);
  await settings.getByTestId('token-input').fill(token);
  await settings.getByTestId('connect-button').click();
  return settings;
}

/** Opens Settings › Sync, clicks "Sync now", waits for the run to finish and closes Settings again. */
async function syncNow(page, isMobile) {
  const settings = await openSettings(page, isMobile);
  await settings.getByTestId('sync-now').click();
  await expect(settings.getByTestId('sync-status')).toHaveAttribute('data-state', 'idle');
  await closeSettings(page, isMobile);
}

/** The workspace currently stored in the fake gist. */
function remoteWorkspace(fake) {
  const [gist] = [...fake.state.gists.values()];
  return gist ? JSON.parse(gist.files[GIST_FILENAME].content).workspace : null;
}

test('a second device adopts the first device\'s data on Connect, then edits flow both ways with Sync now', async ({ browser, contextOptions, isMobile }) => {
  test.slow(); // two devices, three round trips through the fake API
  const fake = createFakeGithub({ login: 'comic' });
  const { ws, ids } = sampleWorkspace();
  const a = await newDevice(browser, contextOptions, fake, ws);
  const b = await newDevice(browser, contextOptions, fake);

  // Device A: first connect creates the gist from its data.
  await open(a.page);
  const settingsA = await connect(a.page, isMobile);
  await expect(settingsA.getByTestId('sync-status')).toHaveAttribute('data-state', 'idle');
  await expect(settingsA).toContainText('Connected as comic');
  await expect(settingsA.locator('a[href^="https://gist.github.com/"]')).toHaveAttribute('href', 'https://gist.github.com/fakegist1');
  await expect(a.page.getByTestId('sync-dot')).toHaveAttribute('data-state', 'idle');
  await expect(a.page.getByTestId('toast').filter({ hasText: 'Connected as comic' })).toBeVisible();
  expect(fake.state.gists.size).toBe(1);
  const [gist] = [...fake.state.gists.values()];
  expect(gist.public).toBe(false);
  expect(gist.description).toBe('Stand-Up Set Builder data');
  expect(remoteWorkspace(fake).versions[0].topics.map((t) => t.title)).toEqual(['Airports', 'Dating']);
  await closeSettings(a.page, isMobile);

  // Device B: pristine, so Connect adopts the remote workspace wholesale — a single version, no copy.
  await open(b.page);
  await expect(b.page.getByTestId('empty-board')).toBeVisible();
  const settingsB = await connect(b.page, isMobile);
  await expect(settingsB.getByTestId('sync-status')).toHaveAttribute('data-state', 'idle');
  await closeSettings(b.page, isMobile);
  await expect(b.page.getByTestId('topic-card')).toHaveCount(2);
  await expect(jokeCard(b.page, ids.security).getByTestId('joke-title')).toHaveValue('Security line');
  await b.page.getByTestId('version-switcher').click();
  await expect(b.page.getByTestId('menu').getByTestId('version-item')).toHaveCount(1);
  await b.page.keyboard.press('Escape');
  await expect(b.page.getByTestId('menu')).toHaveCount(0);
  expect(fake.state.gists.size).toBe(1);

  // Edit on A → Sync now on A pushes → Sync now on B pulls.
  await jokeCard(a.page, ids.security).getByTestId('joke-title').fill('Security theatre');
  await jokeCard(a.page, ids.luggage).getByTestId('joke-inset').check();
  await syncNow(a.page, isMobile);
  await expect.poll(() => remoteWorkspace(fake).versions[0].topics[0].jokes[0].title).toBe('Security theatre');

  await syncNow(b.page, isMobile);
  await expect(jokeCard(b.page, ids.security).getByTestId('joke-title')).toHaveValue('Security theatre');
  await expect(jokeCard(b.page, ids.luggage).getByTestId('joke-inset')).toBeChecked();
  await expect(jokeCard(b.page, ids.luggage).getByTestId('joke-badge')).toHaveText('#3');

  // And back: an edit on B reaches A.
  await jokeCard(b.page, ids.apps).getByTestId('joke-text').fill('Dating apps are just job interviews where everyone lies about their hobbies.');
  await syncNow(b.page, isMobile);
  await syncNow(a.page, isMobile);
  await expect(jokeCard(a.page, ids.apps).getByTestId('joke-text')).toHaveValue(/job interviews/);
  await expect(a.page.getByTestId('version-switcher')).toHaveText(/Set v1/);
  expect(remoteWorkspace(fake).versions).toHaveLength(1);

  await a.context.close();
  await b.context.close();
});

test('the sync config survives a reload and disconnect turns sync off', async ({ browser, contextOptions, isMobile }) => {
  const fake = createFakeGithub();
  const { ws } = sampleWorkspace();
  const a = await newDevice(browser, contextOptions, fake, ws);
  await open(a.page);
  await connect(a.page, isMobile);
  await expect(a.page.getByTestId('sync-dot')).toHaveAttribute('data-state', 'idle');
  const config = await a.page.evaluate(() => JSON.parse(localStorage.getItem('ssb.sync.v1')));
  expect(config).toMatchObject({ token: TOKEN, login: 'tester', gistId: 'fakegist1' });
  expect(Object.keys(config.synced)).toEqual([ws.versions[0].id]);

  await a.page.reload();
  await expect(a.page.getByTestId('sync-dot')).toHaveAttribute('data-state', 'idle');
  const settings = await openSettings(a.page, isMobile);
  await expect(settings).toContainText('Connected as tester');
  await settings.getByTestId('disconnect-button').click();
  await expect(settings.getByTestId('token-input')).toBeVisible();
  await expect(a.page.getByTestId('sync-dot')).toHaveAttribute('data-state', 'off');
  const after = await a.page.evaluate(() => JSON.parse(localStorage.getItem('ssb.sync.v1')));
  expect(after.token).toBeNull();
  expect(after.synced).toEqual(config.synced); // kept so a reconnect merges instead of duplicating
  await a.context.close();
});

test('a rejected token shows the error, saves nothing and leaves sync off', async ({ browser, contextOptions, isMobile }) => {
  const fake = createFakeGithub();
  const a = await newDevice(browser, contextOptions, fake, sampleWorkspace().ws);
  await open(a.page);
  const settings = await connect(a.page, isMobile, 'bad-token');
  await expect(settings.getByTestId('sync-status')).toContainText('GitHub rejected the token');
  await expect(settings.getByTestId('token-input')).toBeVisible();
  await expect(a.page.getByTestId('sync-dot')).toHaveAttribute('data-state', 'off');
  expect(fake.state.gists.size).toBe(0);
  expect(await a.page.evaluate(() => localStorage.getItem('ssb.sync.v1'))).toBeNull();
  await a.context.close();
});

test('the sync dot opens Settings › Sync', async ({ browser, contextOptions, isMobile }) => {
  const fake = createFakeGithub();
  const a = await newDevice(browser, contextOptions, fake);
  await open(a.page);
  await a.page.getByTestId('sync-dot').click();
  await expect(a.page.getByTestId('settings')).toBeVisible();
  await expect(a.page.getByTestId('token-input')).toBeInViewport();
  if (isMobile) await expect(a.page.getByTestId('tab-more')).toHaveAttribute('aria-current', 'page');
  else {
    // The dialog is scrolled so the Sync section starts at its top (not merely visible because the dialog is tall).
    await expect.poll(() => a.page.evaluate(() => {
      const dialog = document.querySelector('dialog.dialog-settings');
      return dialog.querySelector('[data-section="sync"]').getBoundingClientRect().top - dialog.getBoundingClientRect().top;
    })).toBeLessThan(40);
  }
  await a.context.close();
});

test('the app boots without errors when service workers are blocked', async ({ browser, contextOptions }) => {
  // register() resolves without a registration here (and in locked-down browsers); the update flow must cope.
  const fake = createFakeGithub();
  const a = await newDevice(browser, contextOptions, fake);
  const errors = [];
  a.page.on('pageerror', (e) => errors.push(e.message));
  await open(a.page);
  await a.page.getByTestId('add-topic').click();
  await expect(a.page.getByTestId('topic-card')).toHaveCount(1);
  await a.page.waitForTimeout(300);
  expect(errors).toEqual([]);
  await a.context.close();
});
