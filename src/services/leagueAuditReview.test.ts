import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRepairAndRefresh } from './leagueAuditReviewFlow.js';
import { LeagueAuditRepairStaleError } from './leagueAuditResolution.js';
import { buildLeagueAuditConfirmationView, buildLeagueAuditRepairReply, buildLeagueAuditResolutionView, buildLeagueAuditReviewView } from './leagueAuditReviewView.js';

test('a stale repair confirmation refreshes the rolling audit card', async () => {
  let refreshes = 0;
  const result = await executeRepairAndRefresh(
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

test('a failed post-repair refresh does not claim that a source error is a remaining roster issue', () => {
  const reply = buildLeagueAuditRepairReply(
    { status: 'error', issues: ['The audit could not read every required source.'] },
    'YSL-AUD-FIX-A78754D3',
  );

  assert.match(reply, /repair completed/i);
  assert.match(reply, /could not refresh/i);
  assert.match(reply, /will retry/i);
  assert.match(reply, /YSL-AUD-FIX-A78754D3/);
  assert.doesNotMatch(reply, /1 issue remain/i);
});

test('review issues opens one human-readable finding at a time with private pagination', () => {
  const findings = [
    'Little Monsters VD\nDiscord name now: “DilliD (Soka)”\nCurrent Rosters sheet: “DilliD (Soka)”\nPlayer Name History sheet: “DilliD”\nRequired: update the managed roster sheets to the Discord name. Previous names stay in history.',
    'Morty — Discord division: Svartalfheim, Alfheim; expected: Svartalfheim. Make the division role match.',
    'imso cheeky is in Current Rosters but is no longer in the Discord server. Confirm whether this is a departure before changing the roster.',
  ];

  const view = buildLeagueAuditReviewView(findings, 1, 'YSL-AUD-1234');

  assert.equal(view.title, 'League Roster Audit — Discord roles');
  assert.match(view.description, /Morty/);
  assert.match(view.footer, /Issue 2 of 3/);
  assert.deepEqual(view.actions, [
    { id: 'league-audit:page:YSL-AUD-1234:0', label: 'Previous', disabled: false },
    { id: 'league-audit:resolve:YSL-AUD-1234:1', label: 'Resolve this issue', disabled: false },
    { id: 'league-audit:page:YSL-AUD-1234:2', label: 'Next', disabled: false },
  ]);
});

test('name resolution offers one Discord-authoritative action without exposing sheet-model choices', () => {
  const view = buildLeagueAuditResolutionView(
    'Little Monsters VD\nDiscord name now: “DilliD (Soka)”\nCurrent Rosters sheet: “DilliD (Soka)”\nPlayer Name History sheet: “DilliD”\nRequired: update the managed roster sheets to the Discord name. Previous names stay in history.',
    0,
    'YSL-AUD-1234',
  );

  assert.match(view.description, /No changes have been made/i);
  assert.match(view.description, /Discord name/i);
  assert.doesNotMatch(view.description, /official league name/i);
  assert.deepEqual(view.actions, [
    { id: 'league-audit:choice:YSL-AUD-1234:0:use-discord-name', label: 'Preview Discord name update', disabled: false },
    { id: 'league-audit:page:YSL-AUD-1234:0', label: 'Back', disabled: false },
  ]);
});

test('a resolution choice requires a second explicit confirmation', () => {
  const view = buildLeagueAuditConfirmationView(
    'Little Monsters VD\nDiscord name now: “DilliD (Soka)”\nCurrent Rosters sheet: “DilliD (Soka)”\nPlayer Name History sheet: “DilliD”\nRequired: update the managed roster sheets to the Discord name. Previous names stay in history.',
    0,
    'YSL-AUD-1234',
    'use-discord-name',
  );

  assert.match(view.description, /Discord currently shows “DilliD \(Soka\)”/i);
  assert.match(view.description, /keep “DilliD” in name history/i);
  assert.match(view.description, /No changes have been made/i);
  assert.deepEqual(view.actions, [
    { id: 'league-audit:confirm:YSL-AUD-1234:0:use-discord-name', label: 'Update to Discord name', disabled: false },
    { id: 'league-audit:resolve:YSL-AUD-1234:0', label: 'Back', disabled: false },
  ]);
});

test('an absent free agent can be routed to a confirmed inactive-player repair', () => {
  const view = buildLeagueAuditResolutionView(
    'ThePvtFuzzy is listed as a free agent but is no longer in the Discord server. Mark the player inactive if the departure is confirmed.',
    4,
    'YSL-AUD-1234',
  );
  assert.deepEqual(view.actions[0], {
    id: 'league-audit:choice:YSL-AUD-1234:4:mark-inactive', label: 'Mark inactive', disabled: false,
  });
});

test('manual-only findings explain that Discord cannot safely guess a correction', () => {
  const view = buildLeagueAuditReviewView([
    'Vanaheim has more than one division role in League Teams. Use one division role for every Vanaheim team.',
  ], 0, 'YSL-AUD-1234');

  assert.match(view.description, /manual sheet review/i);
  assert.equal(view.actions[1]?.disabled, true);
});
