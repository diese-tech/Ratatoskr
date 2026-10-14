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
  }
});
