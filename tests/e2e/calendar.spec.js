// End-to-end tests for calendar/index.html (Charlie's Datebook), run against the published page shape
// with a fake Artifact runtime (see calendarHarness.js). Runs in the existing desktop and iphone projects.
import { test, expect } from '@playwright/test';
import { openDatebook, unzipStored } from './calendarHarness.js';

const TODAY = new Date(2026, 9, 13, 10, 0, 0); // Tue 13 Oct 2026, 10:00 local

async function expectSynced(page) {
  await expect(page.locator('#syncpill')).toHaveText('Synced');
}

test.describe('Charlie\'s Datebook', () => {
  test('renders the current month, marks today and selects it', async ({ page }) => {
    await openDatebook(page, { clock: TODAY });
    await expect(page.locator('#month-title')).toContainText('October');
    await expect(page.locator('#month-title')).toContainText('2026');
    const today = page.locator('.day.today');
    await expect(today).toHaveAttribute('data-date', '2026-10-13');
    await expect(today).toHaveClass(/selected/);
    await expect(page.locator('#daypage h3')).toHaveText('Tuesday, October 13');
    await expectSynced(page);
    await expect(page.locator('#daypage .empty')).toContainText('Nothing scheduled');
  });

  test('adds an appointment, shows it on the day and in the grid, and persists it to the store', async ({ page, isMobile }) => {
    await openDatebook(page, { clock: TODAY });
    await expectSynced(page);
    await page.locator(isMobile ? '#new-btn-mobile' : '#new-btn').click();
    const dialog = page.locator('#editor');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#editor-title')).toHaveText('New appointment');
    await page.fill('#f-title', 'Dentist');
    await expect(page.locator('#f-date')).toHaveValue('2026-10-13');
    await page.fill('#f-start', '14:00');
    await page.fill('#f-end', '15:00');
    await page.fill('#f-location', 'Main St');
    await page.locator('label.swatch.cat-health').click();
    await page.locator('#save-btn').click();
    await expect(dialog).toBeHidden();
    const row = page.locator('#daypage .item');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Dentist');
    await expect(row).toContainText('2 PM – 3 PM');
    await expect(row).toContainText('Main St');
    await expect(row).toHaveClass(/cat-health/);
    const docs = await page.evaluate(() => window.__fake.docs());
    const saved = Object.values(docs);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: 'event', title: 'Dentist', date: '2026-10-13', start: '14:00', end: '15:00', allDay: false, category: 'health', location: 'Main St', alerts: [15], repeat: 'none' });
    if (isMobile) {
      await expect(page.locator('.day.today .dot')).toHaveCount(1);
    } else {
      await expect(page.locator('.day.today .chip')).toContainText('Dentist');
    }
  });

  test('edits and deletes an appointment', async ({ page }) => {
    const seed = { a1: { kind: 'event', title: 'Standup', date: '2026-10-13', allDay: false, start: '09:00', end: '09:30', repeat: 'none', alerts: [], category: 'work', location: '', notes: '', doneDates: [], createdAt: 1, updatedAt: 1 } };
    await openDatebook(page, { clock: TODAY, seed });
    await expectSynced(page);
    await page.locator('#daypage .item-main').click();
    await expect(page.locator('#editor-title')).toHaveText('Edit appointment');
    await expect(page.locator('#f-title')).toHaveValue('Standup');
    await page.fill('#f-title', 'Standup (moved)');
    await page.locator('#save-btn').click();
    await expect(page.locator('#daypage .item-title')).toHaveText('Standup (moved)');
    await page.locator('#daypage .item-main').click();
    await page.locator('#delete-btn').click();
    await expect(page.locator('#delete-confirm')).toBeVisible();
    await page.locator('#delete-yes').click();
    await expect(page.locator('#editor')).toBeHidden();
    await expect(page.locator('#daypage .empty')).toBeVisible();
    expect(Object.keys(await page.evaluate(() => window.__fake.docs()))).toHaveLength(0);
  });

  test('validates the form', async ({ page, isMobile }) => {
    await openDatebook(page, { clock: TODAY });
    await page.locator(isMobile ? '#new-btn-mobile' : '#new-btn').click();
    await page.locator('#save-btn').click();
    await expect(page.locator('#form-error')).toHaveText('Give it a title.');
    await expect(page.locator('#editor')).toBeVisible();
    await page.fill('#f-title', 'Lunch');
    await page.fill('#f-start', '12:00');
    await page.fill('#f-end', '11:00');
    await page.locator('#save-btn').click();
    await expect(page.locator('#form-error')).toContainText('end time must be after');
  });

  test('reminders can be ticked off per day and recurring ones expand', async ({ page }) => {
    const seed = { r1: { kind: 'reminder', title: 'Take vitamins', date: '2026-10-01', repeat: 'daily', time: '', alerts: [0], doneDates: ['2026-10-12'], notes: '', createdAt: 1, updatedAt: 1 } };
    await openDatebook(page, { clock: TODAY, seed });
    await expectSynced(page);
    const row = page.locator('#daypage .item');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Take vitamins');
    await expect(row).toContainText('Repeats daily');
    await expect(row.locator('.done-check')).not.toBeChecked();
    await row.locator('.done-check').check();
    await expect(row).toHaveClass(/done/);
    const docs = await page.evaluate(() => window.__fake.docs());
    expect(docs.r1.doneDates.sort()).toEqual(['2026-10-12', '2026-10-13']);
    // Yesterday was already done, tomorrow is not.
    await page.locator('.day[data-date="2026-10-14"]').click();
    await expect(page.locator('#daypage .item .done-check')).not.toBeChecked();
    await page.locator('.day[data-date="2026-10-12"]').click();
    await expect(page.locator('#daypage .item .done-check')).toBeChecked();
  });

  test('monthly repeat skips months without that day', async ({ page }) => {
    const seed = { m1: { kind: 'event', title: 'Rent', date: '2026-01-31', allDay: true, repeat: 'monthly', alerts: [], category: 'other', doneDates: [], createdAt: 1, updatedAt: 1 } };
    await openDatebook(page, { clock: TODAY, seed });
    await expectSynced(page);
    await page.locator('.day[data-date="2026-10-31"]').click();
    await expect(page.locator('#daypage .item')).toHaveCount(1);
    await page.locator('#next-btn').click();
    await expect(page.locator('#month-title')).toContainText('November');
    await expect(page.locator('.day[data-date="2026-11-30"] .chip, .day[data-date="2026-11-30"] .dot')).toHaveCount(0);
  });

  test('upcoming view lists the next 30 days and overdue reminders', async ({ page, isMobile }) => {
    const seed = {
      e1: { kind: 'event', title: 'Flight to Denver', date: '2026-10-20', allDay: false, start: '07:15', end: '10:00', repeat: 'none', alerts: [], category: 'travel', doneDates: [], createdAt: 1, updatedAt: 1 },
      r1: { kind: 'reminder', title: 'Renew passport', date: '2026-10-10', repeat: 'none', alerts: [], doneDates: [], createdAt: 1, updatedAt: 1 },
      far: { kind: 'event', title: 'Far away', date: '2026-12-25', allDay: true, repeat: 'none', alerts: [], category: 'family', doneDates: [], createdAt: 1, updatedAt: 1 },
    };
    await openDatebook(page, { clock: TODAY, seed });
    await expectSynced(page);
    await page.locator(isMobile ? '#mtab-upcoming' : '#tab-upcoming').click();
    const view = page.locator('#view-upcoming');
    await expect(view).toBeVisible();
    await expect(view.locator('.group.overdue .item')).toContainText('Renew passport');
    await expect(view).toContainText('Flight to Denver');
    await expect(view).toContainText('Tuesday, October 20');
    await expect(view).not.toContainText('Far away');
    await expect(page.locator('#nav-row')).toBeHidden();
  });

  test('live updates from another device appear without reload', async ({ page }) => {
    await openDatebook(page, { clock: TODAY });
    await expectSynced(page);
    await page.evaluate(() => window.__fake.externalSet('x1', { kind: 'event', title: 'Added on iPhone', date: '2026-10-13', allDay: true, repeat: 'none', alerts: [], category: 'family', doneDates: [], createdAt: 1, updatedAt: 1 }));
    await expect(page.locator('#daypage .item-title')).toHaveText('Added on iPhone');
    await page.evaluate(() => window.__fake.externalDelete('x1'));
    await expect(page.locator('#daypage .empty')).toBeVisible();
  });

  test('a failed write reverts the optimistic change and reports it', async ({ page, isMobile }) => {
    await openDatebook(page, { clock: TODAY, failWrites: 'quota_exceeded' });
    await expectSynced(page);
    await page.locator(isMobile ? '#new-btn-mobile' : '#new-btn').click();
    await page.fill('#f-title', 'Will fail');
    await page.locator('#save-btn').click();
    await expect(page.locator('.toast.error')).toContainText('Couldn’t save');
    await expect(page.locator('#daypage .empty')).toBeVisible();
  });

  test('falls back to this-device storage without the runtime', async ({ page, isMobile }) => {
    await openDatebook(page, { clock: TODAY, db: 'none' });
    await expect(page.locator('#syncpill')).toHaveText('This device only');
    await page.locator(isMobile ? '#new-btn-mobile' : '#new-btn').click();
    await page.fill('#f-title', 'Local only');
    await page.locator('#save-btn').click();
    await expect(page.locator('#daypage .item-title')).toHaveText('Local only');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('datebook.items.v1')));
    expect(Object.values(stored)[0]).toMatchObject({ title: 'Local only' });
  });

  test('fires an in-app alert when a reminder comes due', async ({ page }) => {
    const seed = { e1: { kind: 'event', title: 'Call Mom', date: '2026-10-13', allDay: false, start: '10:15', end: '10:30', repeat: 'none', alerts: [15], category: 'family', doneDates: [], createdAt: 1, updatedAt: 1 } };
    await openDatebook(page, { clock: TODAY, seed }); // 10:00 now; alert is at 10:00
    await expectSynced(page);
    const alert = page.locator('.toast.alert');
    await page.clock.runFor(1000);
    await expect(alert).toContainText('Call Mom');
    await expect(alert).toContainText('In 15 min');
    await alert.locator('.btn-primary').click(); // Open
    await expect(page.locator('#editor-title')).toHaveText('Edit appointment');
    await expect(page.locator('#f-title')).toHaveValue('Call Mom');
  });

  test('exports a zip holding an .ics with alarms through the downloads capability', async ({ page }) => {
    const seed = { e1: { kind: 'event', title: 'Dentist, downtown ☕', date: '2026-10-20', allDay: false, start: '14:00', end: '15:00', repeat: 'weekly', until: '2026-12-01', alerts: [30, 0], category: 'health', location: 'Main St', notes: 'Bring card '.repeat(12), doneDates: [], createdAt: 1, updatedAt: 1 } };
    await openDatebook(page, { clock: TODAY, seed });
    await expectSynced(page);
    await page.locator('#menu-btn').click();
    await page.locator('#export-all-btn').click();
    await expect(page.locator('.toast')).toContainText('Exported');
    const saves = await page.evaluate(() => window.__fake.saves);
    expect(saves).toHaveLength(1);
    expect(saves[0].filename).toBe('charlies-datebook.zip');
    const { name, data: ics } = unzipStored(saves[0].bytes);
    expect(name).toBe('charlies-datebook.ics');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('SUMMARY:Dentist\\, downtown ☕');
    expect(ics).toContain('DTSTART:20261020T140000');
    expect(ics).toContain('DTEND:20261020T150000');
    expect(ics).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261201T235900');
    expect(ics).toContain('TRIGGER:-PT30M');
    expect(ics).toContain('TRIGGER:PT0M');
    expect(ics).toContain('LOCATION:Main St');
    const lines = ics.split('\r\n');
    expect(lines.every(l => Buffer.byteLength(l, 'utf8') <= 75)).toBe(true);
    expect(lines.some(l => l.startsWith(' '))).toBe(true); // the long DESCRIPTION folded
    expect(ics.replace(/\r\n /g, '')).toContain('DESCRIPTION:' + 'Bring card '.repeat(12).trim());
  });

  test('hides export when the viewer refuses the file type', async ({ page }) => {
    const seed = { e1: { kind: 'event', title: 'Lunch', date: '2026-10-13', allDay: true, repeat: 'none', alerts: [], category: 'other', doneDates: [], createdAt: 1, updatedAt: 1 } };
    await openDatebook(page, { clock: TODAY, seed, allowedExtensions: ['txt'] });
    await expectSynced(page);
    await page.locator('#menu-btn').click();
    await page.locator('#export-all-btn').click();
    await expect(page.locator('.toast.error')).toContainText('aren’t available');
    await expect(page.locator('#export-all-btn')).toBeHidden();
    await expect(page.locator('#export-note')).toContainText('aren’t available');
  });

  test('a save made while still connecting is kept and written once the store answers', async ({ page, isMobile }) => {
    await openDatebook(page, { clock: TODAY, delayMs: 1500 });
    await expect(page.locator('#syncpill')).toHaveText('Connecting');
    await page.locator(isMobile ? '#new-btn-mobile' : '#new-btn').click();
    await page.fill('#f-title', 'Early bird');
    await page.locator('#save-btn').click();
    await expect(page.locator('#daypage .item-title')).toHaveText('Early bird');
    await expectSynced(page);
    await expect(page.locator('#daypage .item-title')).toHaveText('Early bird');
    await expect.poll(async () => Object.values(await page.evaluate(() => window.__fake.docs())).map(d => d.title)).toEqual(['Early bird']);
  });

  test('alerts survive the all-day toggle and kind switch picks sensible defaults', async ({ page, isMobile }) => {
    await openDatebook(page, { clock: TODAY });
    await page.locator(isMobile ? '#new-btn-mobile' : '#new-btn').click();
    await expect(page.locator('#f-alert1')).toHaveValue('15');
    await page.locator('#f-allday').check();
    await expect(page.locator('#f-alert1')).toHaveValue('0');
    await expect(page.locator('#f-alert1 option:checked')).toHaveText('On the day (9 AM)');
    await page.locator('#f-allday').uncheck();
    await expect(page.locator('#f-alert1')).toHaveValue('15');
    await page.locator('#kind-seg label:has(#kind-reminder)').click();
    await expect(page.locator('#f-start')).toHaveValue('');
    await expect(page.locator('#f-alert1')).toHaveValue('0');
    await expect(page.locator('#editor-title')).toHaveText('New reminder');
    await page.locator('#kind-seg label:has(#kind-event)').click();
    await expect(page.locator('#f-start')).toHaveValue('10:30');
    await expect(page.locator('#f-end')).toHaveValue('11:30');
    await expect(page.locator('#f-alert1')).toHaveValue('15');
  });

  test('view-only viewers get a read-only calendar', async ({ page }) => {
    const seed = { r1: { kind: 'reminder', title: 'Water plants', date: '2026-10-13', repeat: 'none', alerts: [], doneDates: [], createdAt: 1, updatedAt: 1 } };
    await openDatebook(page, { clock: TODAY, seed, canWrite: false });
    await expect(page.locator('#syncpill')).toHaveText('View only');
    await expect(page.locator('#new-btn')).toBeHidden();
    await expect(page.locator('#new-btn-mobile')).toBeHidden();
    await expect(page.locator('#add-here')).toHaveCount(0);
    await expect(page.locator('#daypage .done-check')).toBeDisabled();
    await page.locator('#daypage .item-main').click();
    await expect(page.locator('#editor-title')).toHaveText('Reminder');
    await expect(page.locator('#save-btn')).toBeHidden();
    await expect(page.locator('#f-title')).toBeDisabled();
    await expect(page.locator('#delete-zone')).toBeHidden();
  });

  test('an alert that fires while the editor is open can be dismissed', async ({ page, isMobile }) => {
    const seed = { e1: { kind: 'event', title: 'Call Mom', date: '2026-10-13', allDay: false, start: '10:15', end: '10:30', repeat: 'none', alerts: [15], category: 'family', doneDates: [], createdAt: 1, updatedAt: 1 } };
    await openDatebook(page, { clock: TODAY, seed });
    await expectSynced(page);
    await page.locator(isMobile ? '#new-btn-mobile' : '#new-btn').click();
    await page.clock.runFor(1000);
    const alert = page.locator('#editor .toast.alert');
    await expect(alert).toContainText('Call Mom');
    await alert.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.toast.alert')).toHaveCount(0);
    await expect(page.locator('#editor')).toBeVisible();
    await page.locator('#editor-close').click();
    await expect(page.locator('#toasts')).toHaveCount(1);
  });

  test('alerts fire once even when browser storage is blocked, and late alerts are marked missed', async ({ page }) => {
    const seed = {
      e1: { kind: 'event', title: 'Call Mom', date: '2026-10-13', allDay: false, start: '10:15', end: '10:30', repeat: 'none', alerts: [15], category: 'family', doneDates: [], createdAt: 1, updatedAt: 1 },
      e2: { kind: 'event', title: 'Breakfast', date: '2026-10-13', allDay: false, start: '08:00', end: '08:30', repeat: 'none', alerts: [0], category: 'personal', doneDates: [], createdAt: 1, updatedAt: 1 },
    };
    await openDatebook(page, { clock: TODAY, seed, blockStorage: true });
    await expectSynced(page);
    await page.clock.runFor(1000);
    await expect(page.locator('.toast.alert')).toHaveCount(2);
    await expect(page.locator('.toast.alert', { hasText: 'Breakfast' })).toContainText('Missed alert');
    await page.clock.runFor(31_000);
    await page.clock.runFor(31_000);
    await expect(page.locator('.toast.alert')).toHaveCount(2);
  });

  test('keyboard focus stays put across live re-renders and month changes', async ({ page, isMobile }) => {
    test.skip(isMobile, 'keyboard focus is a desktop concern');
    const seed = { r1: { kind: 'reminder', title: 'Water plants', date: '2026-10-13', repeat: 'none', alerts: [], doneDates: [], createdAt: 1, updatedAt: 1 } };
    await openDatebook(page, { clock: TODAY, seed });
    await expectSynced(page);
    await page.locator('#daypage .done-check').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#daypage .done-check')).toBeChecked();
    await expect(page.locator('#daypage .done-check')).toBeFocused();
    await page.locator('#next-btn').click();
    await expect(page.locator('.day[tabindex="0"]')).toHaveAttribute('data-date', '2026-11-01');
  });

  test('keyboard: arrows move the selected day across months', async ({ page, isMobile }) => {
    test.skip(isMobile, 'keyboard navigation is a desktop feature');
    await openDatebook(page, { clock: TODAY });
    await page.locator('.day.selected').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.day.selected')).toHaveAttribute('data-date', '2026-10-14');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.day.selected')).toHaveAttribute('data-date', '2026-10-21');
    await page.keyboard.press('PageDown');
    await expect(page.locator('#month-title')).toContainText('November');
    await expect(page.locator('.day.selected')).toHaveAttribute('data-date', '2026-11-21');
    await page.keyboard.press('t');
    await expect(page.locator('.day.selected')).toHaveAttribute('data-date', '2026-10-13');
  });

  test('page never scrolls horizontally', async ({ page }) => {
    const seed = { e1: { kind: 'event', title: 'A very long appointment title that should wrap or truncate instead of widening the page layout', date: '2026-10-13', allDay: true, repeat: 'none', alerts: [], category: 'work', location: 'Somewhere with an extremely long address line that keeps going and going', doneDates: [], createdAt: 1, updatedAt: 1 } };
    await openDatebook(page, { clock: TODAY, seed });
    await expectSynced(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
