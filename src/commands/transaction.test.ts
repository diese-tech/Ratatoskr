import assert from 'node:assert/strict';
import test from 'node:test';
import { persistPreviewAfterDelivery } from '../services/transactionPreview.js';

test('a transaction preview becomes confirmable only after Discord confirms delivery', async () => {
  const events: string[] = [];
  await persistPreviewAfterDelivery(
    async () => { events.push('delivered'); },
    () => { events.push('persisted'); },
  );
  assert.deepEqual(events, ['delivered', 'persisted']);

  let persisted = false;
  await assert.rejects(() => persistPreviewAfterDelivery(
    async () => { throw new Error('Discord delivery failed'); },
    () => { persisted = true; },
  ), /Discord delivery failed/);
  assert.equal(persisted, false);
});
