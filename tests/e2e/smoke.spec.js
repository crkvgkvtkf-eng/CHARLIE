// Smoke test (SPEC §13): empty state → topic → joke → in set → set total → alt → use alt → reload.
// Runs on both projects; on the iPhone project the set lives in the Set tab.
import { test, expect } from '@playwright/test';
import { countWords, formatDuration } from '../../js/timing.js';

// Default pace (SPEC §1): 140 words per minute plus a 2 s pause per joke.
const WPM = 140;
const PAUSE_SEC = 2;
const estimate = (text) => formatDuration((countWords(text) / WPM) * 60 + PAUSE_SEC);
const chipText = (text) => `${estimate(text)} · ${countWords(text)}w`;

const JOKE = 'Airport security took my water bottle but let me keep my anxiety. Apparently only one of those is a liquid.';
const ALT = 'Airport security took my water bottle but let me keep my anxiety. Only one of those is a liquid, and honestly, '
  + 'it is not the one that is going to be a problem at thirty thousand feet when the seatbelt sign comes on and the man '
  + 'next to me starts explaining cryptocurrency.';

test('build a one-joke set from the empty state and keep it across a reload', async ({ page, isMobile }) => {
  const showSet = async () => { if (isMobile) await page.getByTestId('tab-set').click(); };
  const showBoard = async () => { if (isMobile) await page.getByTestId('tab-board').click(); };

  await page.goto('./');
  await expect(page.getByTestId('empty-board')).toBeVisible();

  // Topic: the new title is focused so the writer can type straight away.
  await page.getByTestId('add-topic').click();
  await expect(page.getByTestId('topic-card')).toHaveCount(1);
  await expect(page.getByTestId('topic-title')).toBeFocused();
  await page.getByTestId('topic-title').fill('Airports');
  await expect(page.getByTestId('empty-board')).toHaveCount(0);

  // Joke with text: the time chip reflects the words at 140 wpm + 2 s.
  await page.getByTestId('add-joke').click();
  await expect(page.getByTestId('joke-card')).toHaveCount(1);
  await expect(page.getByTestId('joke-title')).toBeFocused();
  await page.getByTestId('joke-title').fill('Security line');
  await page.getByTestId('joke-text').fill(JOKE);
  await expect(page.getByTestId('joke-time')).toHaveText(chipText(JOKE));
  await expect(page.getByTestId('topic-chip')).toHaveText('0/1 in set · 0:00');

  // Tick "In set": badge, accent class, set list and total.
  await page.getByTestId('joke-inset').check();
  await expect(page.getByTestId('joke-card')).toHaveClass(/in-set/);
  await expect(page.getByTestId('joke-badge')).toHaveText('#1');
  await expect(page.getByTestId('topic-chip')).toHaveText(`1/1 in set · ${estimate(JOKE)}`);
  if (isMobile) await expect(page.getByTestId('tab-set')).toContainText(`Set · ${estimate(JOKE)}`);
  await showSet();
  await expect(page.getByTestId('set-panel')).toBeVisible();
  await expect(page.getByTestId('set-item')).toHaveCount(1);
  await expect(page.getByTestId('set-title')).toContainText('Security line');
  await expect(page.getByTestId('set-total')).toHaveText(estimate(JOKE));
  await expect(page.getByTestId('set-words')).toHaveText(`${countWords(JOKE)} words`);
  await showBoard();

  // Alt: using it in the set changes the delivered text, so the time changes.
  expect(estimate(ALT)).not.toBe(estimate(JOKE));
  await page.getByTestId('add-alt').click();
  await expect(page.getByTestId('alt-card')).toHaveCount(1);
  await expect(page.getByTestId('alt-text')).toBeFocused();
  await page.getByTestId('alt-text').fill(ALT);
  await expect(page.getByTestId('use-original')).toBeChecked();
  await page.getByTestId('alt-use').check();
  await expect(page.getByTestId('use-original')).not.toBeChecked();
  await expect(page.getByTestId('joke-time')).toHaveText(chipText(ALT));
  await showSet();
  await expect(page.getByTestId('set-total')).toHaveText(estimate(ALT));
  await expect(page.getByTestId('set-words')).toHaveText(`${countWords(ALT)} words`);

  // Reload: everything was persisted (debounced save + flush on pagehide).
  await page.reload();
  await expect(page.getByTestId('topic-title')).toHaveValue('Airports');
  await expect(page.getByTestId('joke-title')).toHaveValue('Security line');
  await expect(page.getByTestId('joke-text')).toHaveValue(JOKE);
  await expect(page.getByTestId('alt-text')).toHaveValue(ALT);
  await expect(page.getByTestId('alt-use')).toBeChecked();
  await expect(page.getByTestId('joke-card')).toHaveClass(/in-set/);
  await showSet();
  await expect(page.getByTestId('set-item')).toHaveCount(1);
  await expect(page.getByTestId('set-total')).toHaveText(estimate(ALT));
});
