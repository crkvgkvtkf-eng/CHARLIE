// Id and clock helpers. Both are injectable so tests can produce deterministic ids and timestamps.

let clock = null;
let idFactory = null;

/** Override the clock with a function returning a Date (tests). Pass null to restore the real clock. */
export function setClock(fn) {
  clock = typeof fn === 'function' ? fn : null;
}

/** Override id generation with a function returning a string (tests). Pass null to restore. */
export function setIdFactory(fn) {
  idFactory = typeof fn === 'function' ? fn : null;
}

/** Current time as an ISO-8601 UTC string. */
export function nowIso() {
  return (clock ? clock() : new Date()).toISOString();
}

/** Opaque unique id. Uses crypto.randomUUID when available (iOS 15.4+, all modern desktops). */
export function newId() {
  if (idFactory) return String(idFactory());
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
