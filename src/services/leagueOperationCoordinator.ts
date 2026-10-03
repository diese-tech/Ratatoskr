type Gate = {
  transactionDone?: Promise<void>;
  releaseTransaction?: () => void;
  audit?: Promise<unknown>;
};

const scopes = new WeakMap<object, Map<string, Gate>>();

function gateFor(scope: object, guildId: string): Gate {
  let guilds = scopes.get(scope);
  if (!guilds) { guilds = new Map(); scopes.set(scope, guilds); }
  let gate = guilds.get(guildId);
  if (!gate) { gate = {}; guilds.set(guildId, gate); }
  return gate;
}

export function acquireLeagueTransaction(scope: object, guildId: string): () => void {
  const gate = gateFor(scope, guildId);
  if (gate.transactionDone || gate.audit) {
    throw new Error('Another league transaction or audit is already running. Try again after it finishes.');
  }
  gate.transactionDone = new Promise<void>((resolve) => { gate.releaseTransaction = resolve; });
  return () => {
    gate.releaseTransaction?.();
    gate.transactionDone = undefined;
    gate.releaseTransaction = undefined;
  };
}

export function runCoalescedLeagueAudit<T>(scope: object, guildId: string, task: () => Promise<T>): Promise<T> {
  const gate = gateFor(scope, guildId);
  if (gate.audit) return gate.audit as Promise<T>;
  const waitForTransaction = gate.transactionDone?.catch(() => undefined) ?? Promise.resolve();
  const audit = waitForTransaction.then(task);
  gate.audit = audit;
  void audit.finally(() => {
    if (gate.audit === audit) gate.audit = undefined;
  }).catch(() => undefined);
  return audit;
}
