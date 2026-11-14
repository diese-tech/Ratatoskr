import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRepairAndRefresh } from './leagueAuditReviewFlow.js';
import { LeagueAuditRepairStaleError } from './leagueAuditResolution.js';
import { buildLeagueAuditConfirmationView, buildLeagueAuditRepairReply, buildLeagueAuditResolutionView, buildLeagueAuditReviewView } from './leagueAuditReviewView.js';

test('a stale repair confirmation refreshes the rolling audit card', async () => {
  let refreshes = 0;
  const result = await executeRepairAndRefresh(
    async () => undefined,
    async () => { throw new LeagueAuditRepairStaleError(); },
    async () => {
      refreshes += 1;
      return { status: 'dirty' as const, issues: ['One current issue remains.'], cardId: 'new-card' };
    },
  );

  assert.equal(refreshes, 1);
  assert.deepEqual(result, {
    kind: 'stale-refreshed',
    audit: { status: 'dirty', issues: ['One current issue remains.'], cardId: 'new-card' },
  });
});

test('a repair confirmation disables its controls before starting external work', async () => {
  const events: string[] = [];
  await executeRepairAndRefresh(
    async () => { events.push('processing'); },
    async () => {
      events.push('repair');
      return { reference: 'YSL-AUD-FIX-1234' };
    },
    async () => {
      events.push('refresh');
      return { status: 'clean', issues: [] };
    },
  );

  assert.deepEqual(events, ['processing', 'repair', 'refresh']);
});

test('a failed post-repair refresh does not claim that a source error is a remaining roster issue', () => {
  const reply = buildLeagueAuditRepairReply(
    { status: 'error', issues: ['The audit could not read every required source.'] },
    'YSL-AUD-FIX-A78754D3',
  );

  assert.match(reply, /^Done\. Rat made the fix/);
  assert.match(reply, /couldn’t refresh the League Status card/i);
  assert.match(reply, /check again by itself/i);
  assert.match(reply, /Nothing else needs doing/);
  assert.match(reply, /YSL-AUD-FIX-A78754D3/);
  assert.doesNotMatch(reply, /still need/i);
});

test('a repair reply with problems left says what to press next', () => {
  const reply = buildLeagueAuditRepairReply({ status: 'dirty', issues: ['one', 'two'] }, 'YSL-AUD-FIX-1');
  assert.match(reply, /2 roster problems still need a look: press Review problems on the League Status card/);
});

const nameCard = 'DilliD’s name doesn’t match Discord\nDiscord says: “DilliD (Soka)”\nOur roster says: “DilliD”\nTeam: Little Monsters (Vanaheim)';
const rolesCard = 'Morty’s division doesn’t match\nDiscord says: Svartalfheim and Alfheim\nOur roster says: Svartalfheim';
const departedCard = 'imso cheeky left the server\nThey’re still on Little Monsters (Vanaheim), but they’re no longer in the Discord server.';
const departedFreeAgentCard = 'Free agent ThePvtFuzzy left the server\nThey’re still listed as a free agent, but they’re no longer in the Discord server.';
const manualCard = 'Vanaheim has more than one division role\nEvery Vanaheim team should use the same division role.\nAn admin needs to fix this in the league spreadsheet. Rat can’t pick the right answer by itself.';

test('view roster problems opens one human-readable finding at a time with private pagination', () => {
  const view = buildLeagueAuditReviewView([nameCard, rolesCard, departedCard], 1, 'YSL-AUD-1234');

  assert.equal(view.title, 'Morty’s division doesn’t match');
  assert.match(view.description, /Discord says: Svartalfheim and Alfheim\nOur roster says: Svartalfheim/);
  assert.match(view.description, /Nothing changes until you press Confirm/);
  assert.match(view.footer, /Problem 2 of 3/);
  assert.deepEqual(view.actions, [
    { id: 'league-audit:page:YSL-AUD-1234:0', label: 'Previous', disabled: false },
    { id: 'league-audit:resolve:YSL-AUD-1234:1', label: 'Choose a fix', disabled: false },
    { id: 'league-audit:page:YSL-AUD-1234:2', label: 'Skip for now', disabled: false },
  ]);
});

test('a one-issue audit omits duplicate navigation controls', () => {
  const view = buildLeagueAuditReviewView([departedCard], 0, 'YSL-AUD-ONE');

  assert.deepEqual(view.actions, [
    { id: 'league-audit:resolve:YSL-AUD-ONE:0', label: 'Choose a fix', disabled: false },
  ]);
  assert.equal(new Set(view.actions.map((action) => action.id)).size, view.actions.length);
});

test('name resolution offers one Discord-authoritative action without exposing sheet-model choices', () => {
  const view = buildLeagueAuditResolutionView(nameCard, 0, 'YSL-AUD-1234');

  assert.equal(view.title, 'DilliD’s name doesn’t match Discord');
  assert.match(view.description, /Nothing changes until you press Confirm on the next screen/);
  assert.match(view.description, /Player names come from Discord/);
  assert.doesNotMatch(view.description, /official league name/i);
  assert.deepEqual(view.actions, [
    { id: 'league-audit:choice:YSL-AUD-1234:0:use-discord-name', label: 'Discord is right — update our records', disabled: false },
    { id: 'league-audit:page:YSL-AUD-1234:1', label: 'Skip for now', disabled: false },
    { id: 'league-audit:page:YSL-AUD-1234:0', label: 'Back', disabled: false },
  ]);
});

test('a role finding asks which side is right and answers with the roster', () => {
  const view = buildLeagueAuditResolutionView(rolesCard, 2, 'YSL-AUD-1234');
  assert.match(view.description, /Which one is right\?/);
  assert.deepEqual(view.actions[0], { id: 'league-audit:choice:YSL-AUD-1234:2:repair-roles', label: 'The roster is right — fix Discord', disabled: false });
});

test('a resolution choice requires a second explicit confirmation', () => {
  const view = buildLeagueAuditConfirmationView(nameCard, 0, 'YSL-AUD-1234', 'use-discord-name');

  assert.match(view.description, /What Rat will do:\n- Change DilliD’s league name to “DilliD \(Soka\)” on the roster and the roster page\.\n- Keep “DilliD” as a past name\./);
  assert.match(view.description, /Nothing has changed yet/);
  assert.deepEqual(view.actions, [
    { id: 'league-audit:confirm:YSL-AUD-1234:0:use-discord-name', label: 'Confirm', disabled: false },
    { id: 'league-audit:resolve:YSL-AUD-1234:0', label: 'Back', disabled: false },
  ]);
});

test('an absent free agent can be routed to a confirmed inactive-player repair', () => {
  const view = buildLeagueAuditResolutionView(departedFreeAgentCard, 4, 'YSL-AUD-1234');
  assert.deepEqual(view.actions[0], {
    id: 'league-audit:choice:YSL-AUD-1234:4:mark-inactive', label: 'They left — mark them inactive', disabled: false,
  });
  assert.match(buildLeagueAuditConfirmationView(departedFreeAgentCard, 4, 'YSL-AUD-1234', 'mark-inactive').description, /- Mark ThePvtFuzzy inactive\./);
});

test('an absent rostered player explains both departure and self-drop paths', () => {
  const view = buildLeagueAuditResolutionView(departedCard, 0, 'YSL-AUD-1234');

  assert.equal(view.title, 'imso cheeky left the server');
  assert.match(view.description, /\/transaction departure/);
  assert.match(view.description, /\/transaction self-drop/);
  assert.ok(!view.actions.some((action) => action.id.includes(':choice:')));
});

test('manual-only findings explain that Discord cannot safely guess a correction', () => {
  const view = buildLeagueAuditReviewView([manualCard], 0, 'YSL-AUD-1234');

  assert.match(view.description, /An admin needs to fix this in the league spreadsheet/);
  assert.doesNotMatch(view.description, /Nothing changes until you press Confirm/);
  assert.deepEqual(view.actions, [
    { id: 'league-audit:resolve:YSL-AUD-1234:0', label: 'Choose a fix', disabled: true },
  ]);
});
