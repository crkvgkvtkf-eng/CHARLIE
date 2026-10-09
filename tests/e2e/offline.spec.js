// Offline (SPEC §10, §13.1): after the first load the service worker has precached the app shell,
// so a reload with the network cut still renders the board from the cache. Chromium only.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { open, sampleWorkspace, seed, showSet } from './helpers.js';

test.skip(({ browserName }) => browserName !== 'chromium', 'service-worker offline emulation is exercised in Chromium');

/** The PRECACHE list from sw.js, resolved against the served base so it can be compared with cache keys. */
async function precacheUrls(baseURL) {
  const source = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
  const match = source.match(/const PRECACHE = \[([\s\S]*?)\];/);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => new URL(m[1], baseURL).href);
}

test('the app reloads offline from the service-worker cache', async ({ page, context, baseURL, isMobile }) => {
  const { ws, ids } = sampleWorkspace();
  await seed(page, ws);
  await open(page);
  await expect(page.getByTestId('topic-card')).toHaveCount(2);

  const registration = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: Boolean(reg.active) };
  });
  expect(registration.scope.endsWith('/CHARLIE/')).toBe(true);
  expect(registration.active).toBe(true);

  // Wait until every precache entry is in the ssb-v* cache (the install adds them one by one).
  const expected = await precacheUrls(baseURL);
  await expect.poll(async () => page.evaluate(async () => {
    const keys = await caches.keys();
    const name = keys.find((k) => k.startsWith('ssb-v'));
    if (!name) return [];
    const cache = await caches.open(name);
    return (await cache.keys()).map((r) => r.url);
  }), { timeout: 15_000 }).toEqual(expect.arrayContaining(expected));

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('app')).toBeVisible();
  await expect(page.getByTestId('topic-card')).toHaveCount(2);
  await expect(page.locator(`[data-testid="joke-card"][data-id="${ids.security}"]`).getByTestId('joke-title')).toHaveValue('Security line');
  await expect(page.locator('#boot-fallback')).toBeHidden();
  await expect(page.getByTestId('sync-dot')).toHaveAttribute('data-state', 'off');

  // Still fully usable offline: edits persist locally.
  await page.locator(`[data-testid="joke-card"][data-id="${ids.luggage}"]`).getByTestId('joke-inset').check();
  await showSet(page, isMobile);
  await expect(page.getByTestId('set-item')).toHaveCount(3);
  await context.setOffline(false);
});
