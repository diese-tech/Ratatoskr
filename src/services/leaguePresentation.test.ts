import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leagueActionLabel, leagueStatusLabel, savedLeagueErrorMessage, leagueRepairNoWriteMessage, leagueValidationMessage } from './leaguePresentation.js';

test('stored actions and uncertain writes have readable display names and safe unknown fallbacks', () => {
  assert.equal(leagueActionLabel('repair-roles'), 'Fix Discord roles');
  assert.equal(leagueStatusLabel('BLOCKED_REVIEW'), 'Waiting for staff review');
  assert.match(leagueStatusLabel('RECONCILIATION_REQUIRED'), /some changes may already have happened/);
  assert.equal(leagueStatusLabel('RECONCILED'), 'Checked and closed');
  for (const value of ['UNKNOWN_INTERNAL_CODE', 'constructor', 'toString']) {
    assert.equal(leagueActionLabel(value), 'League action');
    assert.equal(leagueStatusLabel(value), 'Check the saved action');
  }
});

test('saved failures retain the historical name-record cause without showing raw diagnostics', () => {
  assert.match(savedLeagueErrorMessage('This player does not have exactly one current name record. Resolve Player Name History first.'), /Player Name History needs exactly one current name/);
  assert.match(savedLeagueErrorMessage('Interrupted external write; outcome unknown.'), /Some changes may already have happened.*do not run it again/);
  const unknown = savedLeagueErrorMessage('SQLITE_CONSTRAINT token=private-value stack trace');
  assert.ok(!unknown.includes('SQLITE'));
  assert.ok(!unknown.includes('private-value'));
  assert.ok(!unknown.includes('No changes'));
  assert.match(unknown, /Some changes may already have happened/);
  assert.match(unknown, /do not repeat it/);
  assert.doesNotMatch(unknown, /try|retry|again/i);
});

test('known no-write repair failures explain fresh-preview recovery without suggesting uncertain writes', () => {
  for (const message of [
    'This issue changed since this review page opened. Review the refreshed audit before trying again.',
    'The repair source changed since this review page opened. Review a fresh preview and explicitly confirm it before trying again.',
    'SQLITE_CONSTRAINT token=private-value',
  ]) {
    const guidance = leagueRepairNoWriteMessage(message);
    assert.match(guidance, /No changes were made/);
    assert.match(guidance, /fresh preview before approving/);
    assert.doesNotMatch(guidance, /may already|do not repeat|SQLITE|private-value/);
  }
});

test('unmatched technical validation messages use safe guidance rather than leaking into private replies', () => {
  for (const message of [
    'Role is privileged, integration-owned, or not editable.',
    'Only a proven pre-write blocked transaction can receive a fresh preview.',
    'UNRECOGNIZED_DETAIL token=private-value',
  ]) {
    const guidance = leagueValidationMessage(message);
    assert.doesNotMatch(guidance, /privileged|integration-owned|not editable|proven pre-write|UNRECOGNIZED_DETAIL|private-value/);
    assert.match(guidance, /admin|staff/i);
    assert.doesNotMatch(guidance, /before trying|try again/i);
    assert.doesNotMatch(leagueValidationMessage(message, 'read-only'), /Some changes may already have happened/);
  }
});


test('league times stay in Eastern time across daylight saving and legacy UTC rows', async () => {
  const { leagueEasternTime } = await import('./leaguePresentation.js');
  assert.equal(leagueEasternTime('2026-07-01T12:30:00Z'), 'Jul 1, 2026, 8:30 AM EDT');
  assert.equal(leagueEasternTime('2026-01-01T12:30:00Z'), 'Jan 1, 2026, 7:30 AM EST');
  assert.equal(leagueEasternTime('2026-07-01 12:30:00'), 'Jul 1, 2026, 8:30 AM EDT');
  assert.equal(leagueEasternTime('2026-11-01T05:30:00Z'), 'Nov 1, 2026, 1:30 AM EDT');
  assert.equal(leagueEasternTime('2026-11-01T06:30:00Z'), 'Nov 1, 2026, 1:30 AM EST');
  assert.equal(leagueEasternTime(undefined), 'Not checked yet');
  assert.equal(leagueEasternTime('not a date'), 'Time unavailable');
});


test('supported command validation keeps specific correctable reasons', () => {
  for (const message of ['The selected role is not an active YSL team role.', "That is already the player's Current League Name.", 'That league name is already used by another player in this roster area.']) {
    assert.equal(leagueValidationMessage(message, 'read-only'), message);
  }
  assert.match(leagueValidationMessage('The new league name must exactly match the player’s current Discord display name: One.'), /Copy that name from Discord/);
});

test('no-write manual repair failures name the sheet to correct instead of sending staff back to a preview', () => {
  for (const [message, sheet] of [
    ['This player does not have exactly one current name record. Resolve Player Name History first.', 'Player Name History'],
    ['This player has more than one current roster assignment. Resolve Current Rosters first.', 'Current Rosters'],
    ['This player roster points to an ambiguous or inactive team role. Resolve League Teams first.', 'League Teams'],
    ['The expected division role is not configured unambiguously. Resolve League Teams first.', 'League Teams'],
  ]) {
    const text = leagueRepairNoWriteMessage(message!);
    assert.ok(text.includes(sheet!));
    assert.match(text, /No changes were made/);
    assert.match(text, /Correct the named sheet/);
    assert.doesNotMatch(text, /fresh preview|may already/);
  }
});

test('removal failures give consistent removal-specific guidance without saved-action warnings', async () => {
  const { leagueRemovalErrorMessage } = await import('./leaguePresentation.js');
  for (const message of ['Missing Permissions', '429', 'UNEXPECTED_ERROR token=private-value']) {
    const text = leagueRemovalErrorMessage(message);
    assert.match(text, /remaining items before running removal again/);
    assert.doesNotMatch(text, /saved action|do not repeat|UNEXPECTED_ERROR|private-value|may already/);
  }
});
