import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLegacyResolvedLeagueAlertMessage, isResolvedLeagueAlertMessage, leagueStatusCardColor } from './leagueAuditDiscord.js';

test('old and new healthy messages stay green; unfinished actions and failed checks stay red', () => {
  for (const description of ['Status: Healthy', 'Roster status: Healthy', 'Rosters: No problems found.\nProblems to review: 0'])
    assert.equal(leagueStatusCardColor(description), 0x358653);
  for (const description of ['Rosters: Rat could not finish checking.', 'Rosters: No roster problems found in the last check.\nSaved actions need review'])
    assert.equal(leagueStatusCardColor(description), 0xC43C35);
});

test('new roster-review alerts retain narrow legacy cleanup and exact-reference recovery', () => {
  const reference = '12345678-1234-1234-1234-123456789abc';
  for (const action of ['League roster audit review', 'League roster audit repair', 'reviewing roster problems', 'fixing roster problems']) {
    const message = { author: { id: 'rat' }, createdTimestamp: 1,
      content: `Ratatoskr could not finish **${action}**.\nReference: ${reference}` };
    assert.equal(isLegacyResolvedLeagueAlertMessage(message, 'rat', new Date(2).toISOString()), true);
    assert.equal(isResolvedLeagueAlertMessage(message, 'rat', new Set([reference])), true);
    assert.equal(isResolvedLeagueAlertMessage(message, 'rat', new Set([reference + '-other'])), false);
    assert.equal(isLegacyResolvedLeagueAlertMessage({ ...message, author: { id: 'human' } }, 'rat', new Date(2).toISOString()), false);
  }
  const transaction = { author: { id: 'rat' }, createdTimestamp: 1,
    content: `Ratatoskr could not finish **updating the league records**.\nReference: ${reference}` };
  assert.equal(isLegacyResolvedLeagueAlertMessage(transaction, 'rat', new Date(2).toISOString()), false);
});
