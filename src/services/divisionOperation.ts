// One bot process per database is the deployment contract. Reject concurrent
// destructive/provisioning/create work promptly rather than queue an interaction.
const active = new WeakMap<object, Set<string>>();

export function tryAcquireDivisionOperation(scope: object, guildId: string, divisionKey: string): (() => void) | undefined {
  let keys = active.get(scope);
  if (!keys) { keys = new Set(); active.set(scope, keys); }
  const key = `${guildId}:${divisionKey}`;
  if (keys.has(key)) return undefined;
  keys.add(key);
  return () => keys.delete(key);
}
