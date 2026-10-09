// Id and clock helpers. The clock is injectable so tests can produce deterministic timestamps.

let clock = () => new Date();

/** Override the clock (tests). Pass null to restore the real clock. */
export function setClock(fn) {
  clock = fn || (() => new Date());
}

/** Current time as an ISO-8601 UTC string. */
export function nowIso() {
  return clock().toISOString();
}

/** Opaque unique id. Uses crypto.randomUUID when available (iOS 15.4+, all modern desktops). */
export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  let rand = '';
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    c.getRandomValues(bytes);
    rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    rand = Math.random().toString(16).slice(2, 18);
  }
  return `${Date.now().toString(36)}-${rand}`;
}
