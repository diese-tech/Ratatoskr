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
      ['verified', 'player and past moves checked'],
      ['skipped:missing-tab', 'Draft Picks is missing, so the player’s draft history could not be checked'],
      ['skipped:empty-tab', 'Draft Picks is empty, so the player’s draft history could not be checked'],
      ['partial:unverified-slots', 'draft records are incomplete; known player details and past moves were checked, but the other picks still need checking'],
    ];
    for (const [draftVerification, expected] of cases) {
      const text = leagueOpsPreviewText({ replacement: { ...preview, draftVerification } });
      assert.ok(text.includes(`Draft Picks: ${expected}.`), `${draftVerification}: ${text}`);
      if (draftVerification !== 'skipped:missing-tab') assert.ok(!text.includes('tracking tab is missing'));
    }
  } finally { db.close(); }
});
