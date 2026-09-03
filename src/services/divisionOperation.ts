import type Database from 'better-sqlite3';

// One bot process per database is the deployment contract. Reject concurrent
// destructive/provisioning/create work promptly rather than queue an interaction.
const active = new WeakMap<Database.Database, Set<string>>();

export function tryAcquireDivisionOperation(db: Database.Database, guildId: string, divisionKey: string): (() => void) | undefined {
  let keys = active.get(db);
  if (!keys) { keys = new Set(); active.set(db, keys); }
  const key = `${guildId}:${divisionKey}`;
  if (keys.has(key)) return undefined;
  keys.add(key);
  return () => keys.delete(key);
}
