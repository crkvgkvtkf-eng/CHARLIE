// Settings (SPEC §9.7 Pace / Appearance): pace changes update every time display live, out-of-range
// values clamp on blur, the target is entered as m:ss, theme sets data-theme and column width sets --col-w.
import { test, expect } from '@playwright/test';
import { formatDuration } from '../../js/timing.js';
import {
  answerDialog, buildWorkspace, chipText, closeSettings, confirmDialog, jokeCard, open, openSettings, readStored, secondsFor, seed, showSet, words,
} from './helpers.js';

const TEXT = words(70); // 70 words: 30 s at 140 wpm, 60 s at 70 wpm

function oneJokeInSet() {
  return buildWorkspace((w, m) => {
    const t = m.addTopic(w, { title: 'T' });
    const joke = m.addJoke(w, t, { title: 'Seventy', text: TEXT });
    m.addToSet(w, joke);
    return { joke };
  });
}

test('words per minute and pause change the joke chip, topic chip and set total', async ({ page, isMobile }) => {
  const { ws, ids } = oneJokeInSet();
  await seed(page, ws);
  await open(page);
  await expect(jokeCard(page, ids.joke).getByTestId('joke-time')).toHaveText('0:32 · 70w');

  const settings = await openSettings(page, isMobile);
  await settings.getByTestId('wpm-input').fill('70');
  await settings.getByTestId('pause-input').fill('0');
  await expect(settings.locator('.hint').first()).toContainText('350 words ≈ 5:00 at 70 wpm');
  await closeSettings(page, isMobile);

  await expect(jokeCard(page, ids.joke).getByTestId('joke-time')).toHaveText(chipText(TEXT, { wpm: 70, pauseSec: 0 }));
  await expect(page.getByTestId('topic-chip')).toHaveText('1/1 in set · 1:00');
  if (isMobile) await expect(page.getByTestId('tab-set')).toContainText('Set · 1:00');
  await showSet(page, isMobile);
  await expect(page.getByTestId('set-total')).toHaveText('1:00');
  await expect(page.getByTestId('set-delta')).toHaveText('−4:00 under');

  const stored = await readStored(page);
  expect(stored.settings).toMatchObject({ wpm: 70, pauseSec: 0 });

  // Settings persist across a reload.
  await page.reload();
  await expect(jokeCard(page, ids.joke).getByTestId('joke-time')).toHaveText('1:00 · 70w');
});

test('out-of-range pace values are clamped on blur and partial typing does not fight the input', async ({ page, isMobile }) => {
  const { ws } = oneJokeInSet();
  await seed(page, ws);
  await open(page);
  const settings = await openSettings(page, isMobile);
  const wpm = settings.getByTestId('wpm-input');
  await wpm.fill('1000');
  await wpm.blur();
  await expect(wpm).toHaveValue('300');
  await wpm.fill('');
  await wpm.pressSequentially('14');
  await expect(wpm).toHaveValue('14'); // not clamped while typing (SPEC §3.1 updateSettings does not clamp)
  await wpm.pressSequentially('0');
  await wpm.blur();
  await expect(wpm).toHaveValue('140');

  const pause = settings.getByTestId('pause-input');
  await pause.fill('99');
  await pause.blur();
  await expect(pause).toHaveValue('30');
  await pause.fill('2');
  await pause.blur();
  expect((await readStored(page)).settings).toMatchObject({ wpm: 140, pauseSec: 2 });
});

test('target length is edited as m:ss and drives the delta', async ({ page, isMobile }) => {
  const { ws } = oneJokeInSet();
  await seed(page, ws);
  await open(page);
  const settings = await openSettings(page, isMobile);
  const target = settings.getByTestId('target-input');
  await expect(target).toHaveValue('5:00');
  // "m:ss" needs a colon: the iOS numeric keypad has none, so the field must not ask for it.
  await expect(target).not.toHaveAttribute('inputmode', /numeric|decimal|tel/);
  await target.fill('0:45');
  await target.blur();
  await expect(target).toHaveValue('0:45');
  await target.fill('nonsense');
  await target.blur();
  await expect(target).toHaveValue('0:45'); // invalid input reverts
  // Typed one key at a time the field must not be re-formatted underneath the user ("6:3" is 363 s = "6:03").
  await target.fill('');
  await target.pressSequentially('6:30');
  await expect(target).toHaveValue('6:30');
  await target.blur();
  await expect(target).toHaveValue('6:30');
  await target.fill('0:45');
  await target.blur();
  await closeSettings(page, isMobile);
  await showSet(page, isMobile);
  await expect(page.getByTestId('set-target')).toHaveText('0:45');
  await expect(page.getByTestId('set-delta')).toHaveText(`−${formatDuration(45 - secondsFor(TEXT))} under`);
  await expect(page.getByTestId('set-bar')).toHaveAttribute('data-state', 'neutral');
});

test('each pace field is its own undo step', async ({ page, isMobile }) => {
  const { ws } = oneJokeInSet();
  await seed(page, ws);
  await open(page);
  const settings = await openSettings(page, isMobile);
  await settings.getByTestId('wpm-input').fill('150');
  await settings.getByTestId('pause-input').fill('3'); // moving on blurs wpm, which ends its undo run
  await settings.getByTestId('pause-input').blur();
  await closeSettings(page, isMobile);
  await page.getByTestId('undo').click();
  await expect.poll(async () => (await readStored(page)).settings).toMatchObject({ wpm: 150, pauseSec: 2 });
  await page.getByTestId('undo').click();
  await expect.poll(async () => (await readStored(page)).settings).toMatchObject({ wpm: 140, pauseSec: 2 });
});

/** The `theme-color` meta content and the top bar's --topbar token (what §9.1 says it must match). */
async function themeColors(page) {
  return page.evaluate(() => ({
    meta: document.querySelector('meta[name="theme-color"]').content,
    topbar: getComputedStyle(document.documentElement).getPropertyValue('--topbar').trim(),
  }));
}

test('theme and column width apply to the document', async ({ page, isMobile }) => {
  await open(page);
  const root = page.locator('html');
  const settings = await openSettings(page, isMobile);
  await settings.getByTestId('theme-select').selectOption('dark');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  const dark = await themeColors(page);
  expect(dark.meta).toBe(dark.topbar); // the status-bar tint follows the (darker) dark top bar
  await settings.getByTestId('theme-select').selectOption('light');
  await expect(root).toHaveAttribute('data-theme', 'light');
  const light = await themeColors(page);
  expect(light.meta).toBe(light.topbar);
  expect(light.meta).not.toBe(dark.meta);
  await settings.getByTestId('colwidth-select').selectOption('420');
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--col-w'))).toBe('420px');
  await closeSettings(page, isMobile);
  const stored = await readStored(page);
  expect(stored.settings).toMatchObject({ theme: 'light', colWidth: 420 });

  if (!isMobile) {
    await page.getByTestId('add-topic').click();
    await expect.poll(async () => (await page.getByTestId('topic-card').boundingBox()).width).toBe(420);
  }
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');
});

test('a toast raised while the Settings dialog is open is visible above it and can be dismissed', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Settings is a page, not a modal dialog, on the phone');
  const { ws } = oneJokeInSet();
  await seed(page, ws);
  await open(page);
  const settings = await openSettings(page, isMobile);
  await settings.getByTestId('import-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
  const toast = page.getByTestId('toast').filter({ hasText: 'not valid JSON' });
  await expect(toast).toHaveCount(1);
  // A modal dialog makes the rest of the page inert: the toast must be hit-testable, i.e. rendered inside the dialog.
  const onTop = await toast.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
  });
  expect(onTop).toBe(true);
  await toast.getByRole('button', { name: 'Dismiss' }).click({ timeout: 2000 });
  await expect(page.getByTestId('toast')).toHaveCount(0);

  // A persistent toast moves back out with the dialog.
  await settings.getByTestId('import-input').setInputFiles({ name: 'bad2.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
  await expect(page.getByTestId('toast')).toHaveCount(1);
  await closeSettings(page, isMobile);
  await expect(page.getByTestId('toast')).toHaveCount(1);
  await expect(page.getByTestId('toast')).toBeVisible();
});

test('a press inside a dialog released over the backdrop (selecting text) does not close it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'selecting text by dragging the mouse is a desktop gesture');
  const { ws } = oneJokeInSet();
  await seed(page, ws);
  await open(page);
  const settings = await openSettings(page, false);
  const dragOut = async (from) => {
    await page.mouse.move(from.x + 20, from.y + 8);
    await page.mouse.down();
    await page.mouse.move(40, 450, { steps: 5 }); // the dark backdrop, left of the dialog
    await page.mouse.up();
  };
  await dragOut(await settings.locator('.hint').first().boundingBox());
  await expect(settings).toBeVisible();

  // Same for a confirm: it stays open and still answers.
  await settings.getByTestId('reset-button').click();
  const confirm = confirmDialog(page);
  await dragOut(await confirm.locator('.dialog-message').boundingBox());
  await expect(confirm).toBeVisible();
  await answerDialog(page, { confirm: false });
  await expect(settings).toBeVisible();

  // A plain click on the backdrop still closes the dialog.
  await page.mouse.click(40, 450);
  await expect(settings).toHaveCount(0);
});
