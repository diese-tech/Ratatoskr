import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireLeagueTransaction, runCoalescedLeagueAudit } from './leagueOperationCoordinator.js';

test('an audit waits for the active transaction and overlapping audit triggers share the queued run', async () => {
  const scope = {};
  const release = acquireLeagueTransaction(scope, 'guild');
  let auditRuns = 0;
  const first = runCoalescedLeagueAudit(scope, 'guild', async () => { auditRuns += 1; return 'audited'; });
  const second = runCoalescedLeagueAudit(scope, 'guild', async () => { auditRuns += 1; return 'duplicate'; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auditRuns, 0);

  release();

  assert.deepEqual(await Promise.all([first, second]), ['audited', 'audited']);
  assert.equal(auditRuns, 1);
});

test('a transaction fails fast while an audit owns the league-operation gate', async () => {
  const scope = {};
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  const audit = runCoalescedLeagueAudit(scope, 'guild', async () => { await waiting; });
  assert.throws(() => acquireLeagueTransaction(scope, 'guild'), /transaction or audit is already running/i);
  finish();
  await audit;
});
