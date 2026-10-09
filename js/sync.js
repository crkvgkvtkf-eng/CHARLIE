// STUB — replaced by the real implementation (see docs/SPEC.md §7). Exists so dependent modules can import during development.
export const GIST_FILENAME = 'standup-set-builder.json';
export class SyncError extends Error {}
export function createClient() { throw new Error('sync.js not implemented'); }
export function merge() { throw new Error('sync.js not implemented'); }
export async function runSync() { throw new Error('sync.js not implemented'); }
export function syncedMapOf(ws) { return Object.fromEntries((ws.versions || []).map((v) => [v.id, v.updatedAt])); }
