import assert from 'node:assert/strict';
import test from 'node:test';
import { runIsolatedStartupRecovery } from './startupRecovery.js';

test('isolated startup recovery succeeds without reporting', async () => {
  let reports = 0;
  const recovered = await runIsolatedStartupRecovery(
    'League transaction recovery',
    async () => undefined,
    async () => { reports += 1; },
  );
  assert.equal(recovered, true);
  assert.equal(reports, 0);
});

test('isolated startup recovery cannot abort later startup when recovery or reporting fails', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const original = new Error('Sheets unavailable');
  let reported: unknown;
  const recovered = await runIsolatedStartupRecovery(
    'League transaction recovery',
    async () => { throw original; },
    async (error) => { reported = error; throw new Error('staff-ops unavailable'); },
  );
  assert.equal(recovered, false);
  assert.equal(reported, original);
});
