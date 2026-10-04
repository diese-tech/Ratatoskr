import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLeagueAuditConfirmationView, buildLeagueAuditResolutionView, buildLeagueAuditReviewView } from './leagueAuditReviewView.js';

test('review issues opens one human-readable finding at a time with private pagination', () => {
  const findings = [
    'Little Monsters VD — Current Rosters: “DilliD (Soka)”; Player Name History: “DilliD”. Make the names match.',
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

test('name resolution offers both authoritative choices without changing anything yet', () => {
  const view = buildLeagueAuditResolutionView(
    'Little Monsters VD — Current Rosters: “DilliD (Soka)”; Player Name History: “DilliD”. Make the names match.',
    0,
    'YSL-AUD-1234',
  );

  assert.match(view.description, /No changes have been made/i);
  assert.deepEqual(view.actions, [
    { id: 'league-audit:choice:YSL-AUD-1234:0:use-league-name', label: 'Use league name', disabled: false },
    { id: 'league-audit:choice:YSL-AUD-1234:0:use-roster-name', label: 'Use roster name', disabled: false },
    { id: 'league-audit:page:YSL-AUD-1234:0', label: 'Back', disabled: false },
  ]);
});

test('a resolution choice requires a second explicit confirmation', () => {
  const view = buildLeagueAuditConfirmationView(
    'Little Monsters VD — Current Rosters: “DilliD (Soka)”; Player Name History: “DilliD”. Make the names match.',
    0,
    'YSL-AUD-1234',
    'use-league-name',
  );

  assert.match(view.description, /Current Rosters.*DilliD/i);
  assert.match(view.description, /No changes have been made/i);
  assert.deepEqual(view.actions, [
    { id: 'league-audit:confirm:YSL-AUD-1234:0:use-league-name', label: 'Confirm repair', disabled: false },
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
