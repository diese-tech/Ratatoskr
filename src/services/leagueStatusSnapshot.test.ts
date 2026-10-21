import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from 'discord.js';
import { buildLeagueStatusSnapshot } from './leagueStatusSnapshot.js';
import { hasLeagueStatusReceipt, leagueStatusCardColor } from './leagueAuditDiscord.js';
const ready = ['Draft picks checked: all 96 top-four picks have matching player records.\nNext: No setup action needed.'];

test('healthy snapshot has two short lines, one Eastern check time and two controls', () => {
  const card = buildLeagueStatusSnapshot({ result: 'clean', problems: 0, unfinished: 0, lastFullAt: '2026-10-21T12:08:00Z', draftFindings: ready });
  assert.equal(card.title, 'League Status · All clear');
  assert.equal(card.description, 'No roster problems or unfinished actions.\nDraft records: up to date.');
  assert.equal(card.footer, 'Last roster check: Oct 21, 2026, 8:08 AM EDT');
  assert.deepEqual(card.actions?.map(action => action.label), ['Open league tools', 'Check again']);
  assert.equal(leagueStatusCardColor(card.description, card.title), 0x358653);
});

test('attention snapshots preserve counts, failed checks and draft uncertainty without exposing details', () => {
  const attention = buildLeagueStatusSnapshot({ result: 'dirty', problems: 3, unfinished: 1, lastFullAt: '2026-01-01T12:00:00Z', draftFindings: ['Draft Picks missing: private workbook setup instructions'] });
  assert.equal(attention.description, '3 roster problems · 1 unfinished action\nDraft records: needs attention.');
  assert.equal(attention.actions?.[0]?.label, 'Review problems');
  assert.match(attention.footer, /7:00 AM EST/);
  assert.equal(leagueStatusCardColor(attention.description, attention.title), 0xC43C35);
  const failed = buildLeagueStatusSnapshot({ result: 'error', problems: 0, unfinished: 0 });
  assert.match(failed.title, /Check incomplete/);
  assert.match(failed.description, /not confirmed/);
  assert.match(failed.description, /No roster changes were made by this check/);
  assert.doesNotMatch(failed.description, /No roster problems|up to date/);
  const waiting = buildLeagueStatusSnapshot({ result: 'clean', problems: 0, unfinished: 0 });
  assert.match(waiting.title, /Checking/);
  assert.match(waiting.footer, /Not checked yet/);
  const unknownDraft = buildLeagueStatusSnapshot({ result: 'clean', problems: 0, unfinished: 0, lastFullAt: '2026-10-21T12:00:00Z' });
  assert.match(unknownDraft.description, /Draft records: not checked yet/);
  assert.doesNotMatch(unknownDraft.title, /All clear/);
});

test('snapshot send recovery recognizes exact button receipts without a visible footer reference', () => {
  const reference = 'YSL-AUD-12345678';
  const message = { nonce: null, embeds: [{ footer: { text: 'Last roster check: Oct 21, 8 AM EDT' } }], components: [{ components: [{ customId: `league-ops:open:${reference}` }] }] } as unknown as Pick<Message, 'nonce' | 'embeds' | 'components'>;
  assert.equal(hasLeagueStatusReceipt(message, reference), true);
  assert.equal(hasLeagueStatusReceipt(message, 'YSL-AUD-1234567'), false);
  assert.equal(hasLeagueStatusReceipt({ ...message, components: [], embeds: [{ footer: { text: `Old footer • ${reference}` } }] } as unknown as typeof message, reference), true);
});
