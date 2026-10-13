import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../db/client.js';
import { accountReplacementSources } from './accountReplacement.test-support.js';
import { LeagueAccountReplacementService, type AccountReplacementPreview } from './leagueAccountReplacement.js';
import { leagueOpsPreviewText } from './leagueOpsFlow.js';

test('replacement previews distinguish verified, missing, empty and partial draft tracking', async () => {
  const db = openDatabase(':memory:');
  try {
    const service = new LeagueAccountReplacementService({ ...accountReplacementSources(), db, operationScope: db,
      guildId: 'g', freeAgentRoleId: 'fa', authorize: async () => {}, enqueue: () => { throw Error('Preview must not enqueue'); } });
    const preview = await service.preview('admin', 'one', 'new');
    const cases: Array<[AccountReplacementPreview['draftVerification'], string]> = [
      ['verified', 'identity and move continuity checked'],
      ['skipped:missing-tab', 'tracking tab is missing; draft verification was skipped'],
      ['skipped:empty-tab', 'tracking tab is empty; draft verification was skipped'],
      ['partial:unverified-slots', 'tracking is incomplete; matched identity and move continuity checked; remaining slots are not verified'],
    ];
    for (const [draftVerification, expected] of cases) {
      const text = leagueOpsPreviewText({ replacement: { ...preview, draftVerification } });
      assert.ok(text.includes(`Draft Picks: ${expected}.`), `${draftVerification}: ${text}`);
      if (draftVerification !== 'skipped:missing-tab') assert.ok(!text.includes('tracking tab is missing'));
    }
  } finally { db.close(); }
});
