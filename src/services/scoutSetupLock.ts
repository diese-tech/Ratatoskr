const locksByScope = new WeakMap<object, Map<number, Promise<void>>>();

/** Serializes signup state and closure; Discord card delivery uses its own lock. */
export async function withScoutSetupLock<T>(scope: object, setupId: number, task: () => Promise<T>): Promise<T> {
  let locks = locksByScope.get(scope);
  if (!locks) { locks = new Map(); locksByScope.set(scope, locks); }
  const previous = locks.get(setupId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  locks.set(setupId, tail);
  await previous;
  try { return await task(); }
  finally { release(); if (locks.get(setupId) === tail) locks.delete(setupId); }
}
