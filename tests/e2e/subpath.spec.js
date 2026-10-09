// Sub-path hosting (SPEC §1, §13): the app is served under /CHARLIE/ exactly like GitHub Pages.
// Every same-origin request during load, interaction and reload must stay inside that prefix,
// the service worker scope must end in /CHARLIE/, and index.html must not use a <base> element.
import { test, expect } from '@playwright/test';
import { open, sampleWorkspace, seed, showSet } from './helpers.js';

const HOST = '127.0.0.1:4173';

test('every request stays under /CHARLIE/ and the service worker is scoped to it', async ({ page, isMobile, baseURL }) => {
  const requests = [];
  const failures = [];
  page.on('request', (req) => requests.push(req.url()));
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.host === HOST && res.status() >= 400) failures.push(`${res.status()} ${res.url()}`);
  });
  page.on('requestfailed', (req) => failures.push(`failed ${req.url()}`));

  const { ws } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope.endsWith('/CHARLIE/')).toBe(true);
  expect(scope.startsWith(baseURL.replace(/\/$/, ''))).toBe(true);

  // Interact across the UI so lazily referenced assets (icons, manifest) are requested too.
  await page.getByTestId('add-topic').last().click();
  await page.getByTestId('topic-title').last().fill('Sub-path');
  await showSet(page, isMobile);
  if (isMobile) await page.getByTestId('tab-more').click();
  else await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('topic-card')).toHaveCount(3);

  const sameOrigin = requests.filter((u) => new URL(u).host === HOST);
  expect(sameOrigin.length).toBeGreaterThan(5);
  const outside = sameOrigin.filter((u) => !new URL(u).pathname.startsWith('/CHARLIE/'));
  expect(outside).toEqual([]);
  expect(failures).toEqual([]);

  // Resources the browser fetched (including those the service worker answered) agree.
  const entries = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
  expect(entries.filter((u) => new URL(u).host === HOST && !new URL(u).pathname.startsWith('/CHARLIE/'))).toEqual([]);
});

test('index.html has no <base> element and the manifest is relative', async ({ request, baseURL }) => {
  const html = await (await request.get(`${baseURL}index.html`)).text();
  expect(html).not.toMatch(/<base[\s>]/i);
  expect(html).toContain('href="./css/app.css"');
  expect(html).toContain('src="./js/app.js"');
  expect(html).not.toMatch(/(href|src)="\/(?!\/)/); // no root-absolute URLs

  const manifest = await (await request.get(`${baseURL}manifest.webmanifest`)).json();
  expect(manifest.start_url).toBe('./');
  expect(manifest.scope).toBe('./');
  expect(manifest.id).toBe('./');
  for (const icon of manifest.icons) expect(icon.src.startsWith('/')).toBe(false);

  // Outside the prefix the server answers 404, as GitHub Pages would.
  const origin = new URL(baseURL).origin;
  expect((await request.get(`${origin}/css/app.css`)).status()).toBe(404);
  expect((await request.get(`${origin}/sw.js`)).status()).toBe(404);
});
