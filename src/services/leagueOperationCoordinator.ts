// Serializes canonical league work, including callers outside the durable worker.
// Presentation is deliberately outside this coordinator.
type Gate = { tail: Promise<void>; audit?: Promise<unknown> };
const scopes = new WeakMap<object, Map<string, Gate>>();
function gateFor(scope: object, guildId: string): Gate {
  let guilds = scopes.get(scope);
  if (!guilds) { guilds = new Map(); scopes.set(scope, guilds); }
  let gate = guilds.get(guildId);
  if (!gate) { gate = { tail: Promise.resolve() }; guilds.set(guildId, gate); }
  return gate;
}
export async function acquireLeagueTransaction(scope: object, guildId: string): Promise<() => void> {
  const gate = gateFor(scope,guildId);
  const previous = gate.tail;
  let release!: () => void;
  gate.tail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  return release;
}
export function runCoalescedLeagueAudit<T>(scope: object, guildId: string, task: () => Promise<T>): Promise<T> {
  const gate = gateFor(scope,guildId);
  if (gate.audit) return gate.audit as Promise<T>;
  const audit = (async () => { const release = await acquireLeagueTransaction(scope,guildId); try { return await task(); } finally { release(); } })();
  gate.audit = audit;
  void audit.finally(() => { if (gate.audit === audit) gate.audit = undefined; }).catch(() => undefined);
  return audit;
}
