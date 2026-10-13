# Charlie's Datebook

A personal calendar for appointments and reminders that stays in sync across a Mac, an iPad and an iPhone.

One file, no build step: `index.html` holds the whole app. It is written for the claude.ai **Artifact** viewer,
which hosts it as a private page, wraps it in a document skeleton and gives it a shared document store, so the
same link shows the same appointments on every device you are signed in to.

## Open it on each device

The app lives at the artifact link Claude gave you (also listed at <https://claude.ai/code/artifacts>).

- **Mac:** open the link in Safari or Chrome while signed in to claude.ai. Bookmark it, or Safari → File → Add to Dock.
- **iPad / iPhone:** open the link in the Claude app or in Safari (signed in). Safari → Share → Add to Home Screen
  gives it an icon.

The pill next to the name tells you where your data is:

| Pill | Meaning |
| --- | --- |
| **Synced** | Saved to the artifact's shared store; every device signed in to your account sees the same items live. |
| **This device only** | Opened outside the viewer (for example from GitHub Pages); items are saved in that browser only. |
| **View only** | Signed in as someone who can open the page but not change it. |

## What it does

- **Month view** with a day page for the selected day; **Upcoming** lists the next 30 days plus overdue reminders.
- **Appointments** have a date, start and end time (or all day), a category colour, location, notes, and up to two alerts.
- **Reminders** have a date, an optional time, and a tick box per day (a daily reminder is ticked off day by day).
- Both can **repeat** daily, weekly, monthly or yearly, with an optional end date. Monthly repeats skip months that
  have no such day (a repeat on the 31st does not fire in November).
- **Alerts** appear inside the app while it is open on any device: a banner at the bottom, an optional chime, and a
  system notification where the browser allows it. Each device shows an alert once.
- **Export to Apple Calendar:** Options → Export writes a `.zip` holding `charlies-datebook.ics` (every item with its
  alarms). Open the zip, then open the `.ics`: Calendar on the Mac imports it, and on iPhone or iPad the Files app
  unpacks the zip and the `.ics` offers **Add All**. iCloud then carries those events and alerts to all your devices,
  including when the app is closed. The editor's **Export** button does the same for one item.
- Keyboard on the Mac: arrow keys move the selected day, Page Up / Page Down change the month, `n` makes a new item, `t` jumps to today.

## Development

```sh
npm ci
npx playwright test tests/e2e/calendar.spec.js        # desktop + iPhone emulation
```

`tests/e2e/calendarHarness.js` serves `index.html` in the published shape with a fake `window.claude` runtime
(`db`, `user`, `downloads`), so the tests exercise exactly the file that gets published.

To republish after a change, ask Claude to publish `calendar/index.html` to the existing artifact URL with
`capabilities: { db: {}, user: {}, downloads: true }`.
