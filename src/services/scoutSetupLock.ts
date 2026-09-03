import type Database from 'better-sqlite3';

const locksByDatabase = new WeakMap<Database.Database, Map<number, Promise<void>>>();

/** Serializes signup state and closure; Discord card delivery uses its own lock. */
export async function withScoutSetupLock<T>(db: Database.Database, setupId: number, task: () => Promise<T>): Promise<T> {
  let locks = locksByDatabase.get(db);
  if (!locks) { locks = new Map(); locksByDatabase.set(db, locks); }
  const previous = locks.get(setupId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  locks.set(setupId, tail);
  await previous;
  try { return await task(); }
  finally { release(); if (locks.get(setupId) === tail) locks.delete(setupId); }
}
