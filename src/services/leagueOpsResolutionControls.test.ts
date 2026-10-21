import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLeagueRoster } from '../domain/leagueOperations.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import { leagueOpsRepairAction } from './leagueOpsReview.js';
import { accountReplacementSources } from './accountReplacement.test-support.js';
import { previewLeagueAuditResolution } from './leagueAuditResolution.js';

test('every supported live role discrepancy offers the canonical repair through League Ops', async () => {
  for (const roles of [['a', 'b', 'division'], ['b', 'division', 'fa'], ['division'], ['b']]) {
    const sources = accountReplacementSources();
    sources.members.get('two')!.roleIds = roles;
    const loaded = await sources.sheets.load([...sources.members.values()], 'fa');
    for (const diagnostic of auditLeagueRoster(loaded.snapshot).filter(value => value.startsWith('Discord member two '))) {
      const finding = humanizeLeagueAuditIssues(loaded.snapshot, [diagnostic])[0]!;
      assert.equal(leagueOpsRepairAction(finding), 'repair-roles', finding);
      assert.ok(previewLeagueAuditResolution(loaded, finding, 'repair-roles').fingerprint);
    }
    assert.equal(sources.gateway.writes.length, 0);
  }
});

test('configuration and missing public sections never offer an unsupported repair', async () => {
  const sources = accountReplacementSources();
  const loaded = await sources.sheets.load([...sources.members.values()], 'fa');
  for (const diagnostic of [
    'Role a is configured as both a team role and a division role.',
    'Vanaheim Dream Walkers has no managed public roster block.',
    'Vanaheim Dream Walkers has duplicate current player names.',
  ]) {
    const finding = humanizeLeagueAuditIssues(loaded.snapshot, [diagnostic])[0]!;
    assert.equal(leagueOpsRepairAction(finding), undefined, finding);
  }
});


test('role repair previews identify the player and role names before approval', async () => {
  const sources = accountReplacementSources();
  sources.members.get('two')!.roleIds = ['a', 'division', 'fa'];
  const loaded = await sources.sheets.load([...sources.members.values()], 'fa');
  const diagnostic = auditLeagueRoster(loaded.snapshot).find(value => value.startsWith('Discord member two '))!;
  const finding = humanizeLeagueAuditIssues(loaded.snapshot, [diagnostic])[0]!;
  const preview = previewLeagueAuditResolution(loaded, finding, 'repair-roles');
  assert.match(preview.description, /Two/);
  assert.ok(preview.description.includes(loaded.snapshot.teams.find(team => team.teamRoleId === 'b')!.teamRole));
  assert.match(preview.description, /Remove Discord roles: .*Free Agent/);
  assert.match(preview.description, /roster sheets stay the same/);
  assert.equal(sources.gateway.writes.length, 0);
});
