import { leagueFindingBody, leagueFindingKind, leagueFindingTitle } from './leagueAuditPresentation.js';

export type LeagueAuditReviewAction = { id: string; label: string; disabled: boolean };
export type LeagueAuditReviewView = {
  title: string;
  description: string;
  footer: string;
  actions: LeagueAuditReviewAction[];
};

export type LeagueAuditResolutionAction = 'use-discord-name' | 'use-league-name' | 'use-roster-name' | 'repair-roles' | 'sync-public-roster' | 'mark-inactive';

export const NOTHING_CHANGES_YET = 'Nothing changes until you press Confirm on the next screen.';

export function buildLeagueAuditRepairReply(
  result: { status: 'clean' | 'dirty' | 'error'; issues: string[] },
  reference: string,
): string {
  if (result.status === 'error') {
    return `Done. Rat made the fix, but couldn’t refresh the League Status card because Discord or Google Sheets was busy. Rat will check again by itself. Nothing else needs doing. Reference: ${reference}`;
  }
  if (result.status === 'clean') {
    return `Done. Rat made the fix and there are no roster problems left. Nothing else needs doing. Reference: ${reference}`;
  }
  const count = `${result.issues.length} roster problem${result.issues.length === 1 ? '' : 's'}`;
  return `Done. Rat made the fix. ${count} still need${result.issues.length === 1 ? 's' : ''} a look: press Review problems on the League Status card. Reference: ${reference}`;
}

function canResolveInDiscord(finding: string): boolean {
  return leagueFindingKind(finding) !== 'manual';
}

export function buildLeagueAuditReviewView(findings: string[], requestedPage: number, reference: string): LeagueAuditReviewView {
  const page = Math.max(0, Math.min(requestedPage, Math.max(0, findings.length - 1)));
  const finding = findings[page] ?? 'No roster problems left\nEverything matches. Nothing else needs doing.';
  const resolvable = findings.length > 0 && canResolveInDiscord(finding);
  // A manual finding's card already says why Rat can't fix it and who can.
  const resolveAction = { id: `league-audit:resolve:${reference}:${page}`, label: 'Choose a fix', disabled: !resolvable };
  return {
    title: leagueFindingTitle(finding),
    description: `${leagueFindingBody(finding)}${resolvable ? `\n\n${NOTHING_CHANGES_YET}` : ''}`,
    footer: `Problem ${findings.length ? page + 1 : 0} of ${findings.length}`,
    actions: findings.length <= 1 ? [resolveAction] : [
      { id: `league-audit:page:${reference}:${Math.max(0, page - 1)}`, label: 'Previous', disabled: page === 0 },
      resolveAction,
      { id: `league-audit:page:${reference}:${Math.min(findings.length - 1, page + 1)}`, label: 'Skip for now', disabled: page >= findings.length - 1 },
    ],
  };
}

export function buildLeagueAuditResolutionView(
  finding: string,
  page: number,
  reference: string,
): LeagueAuditReviewView {
  const back = { id: `league-audit:page:${reference}:${page}`, label: 'Back', disabled: false };
  const skip = { id: `league-audit:page:${reference}:${page + 1}`, label: 'Skip for now', disabled: false };
  const view = (title: string, question: string, choice?: [LeagueAuditResolutionAction, string]): LeagueAuditReviewView => ({
    title,
    description: `${leagueFindingBody(finding)}\n\n${question}${choice ? `\n\n${NOTHING_CHANGES_YET}` : ''}`,
    footer: `Problem ${page + 1}`,
    actions: [...(choice ? [{ id: `league-audit:choice:${reference}:${page}:${choice[0]}`, label: choice[1], disabled: false }] : []), skip, back],
  });
  switch (leagueFindingKind(finding)) {
    case 'name': return view(leagueFindingTitle(finding), 'Player names come from Discord. Which name is right?',
      ['use-discord-name', 'Discord is right — update our records']);
    case 'roles': return view(leagueFindingTitle(finding), 'Which one is right?', ['repair-roles', 'The roster is right — fix Discord']);
    case 'public': return view(leagueFindingTitle(finding), 'Which one is right?', ['sync-public-roster', 'The roster is right — fix the roster page']);
    case 'departed-free-agent': return view(leagueFindingTitle(finding), 'If they’ve left the league, mark them inactive. That takes them off the free agent list.',
      ['mark-inactive', 'They left — mark them inactive']);
    case 'departed': return view(leagueFindingTitle(finding),
      'What happened?\n- They left the league: run `/transaction departure`.\n- They dropped themselves: run `/transaction self-drop`.\nBoth work for a player who already left the server, and let you pick an optional replacement. Each one shows you the changes before anything happens.');
    default: return view(leagueFindingTitle(finding), 'Rat can’t fix this one by itself. Ask an admin to fix it in the league spreadsheet.');
  }
}

export function buildLeagueAuditConfirmationView(
  finding: string,
  page: number,
  reference: string,
  action: LeagueAuditResolutionAction,
): LeagueAuditReviewView {
  const discordName = finding.match(/^Discord says: “([^”]*)”$/m)?.[1] ?? 'their Discord name';
  const oldName = finding.match(/^Our roster says: “([^”]*)”$/m)?.[1] ?? 'the old name';
  const player = leagueFindingTitle(finding).replace(/’s .*$|^Free agent | left the server$/g, '');
  const changes: Record<LeagueAuditResolutionAction, string[]> = {
    'use-discord-name': [`Change ${player}’s league name to “${discordName}” on the roster and the roster page.`, `Keep “${oldName}” as a past name.`],
    'use-league-name': ['Change the team roster to use the name from the name list.', 'Fix the roster page only if it also differs.'],
    'use-roster-name': ['Make the team roster’s name the official league name.', 'Update the roster page and keep the old name as a past name.'],
    'repair-roles': [`Change ${player}’s Discord team, division and Free Agent roles to match the roster.`, 'The roster stays the same.'],
    'sync-public-roster': ['Update this roster page so it lists the same players as our roster.', 'Nothing else changes.'],
    'mark-inactive': [`Mark ${player} inactive.`, 'Take them off the free agent list.'],
  };
  return {
    title: 'Confirm this fix',
    description: `${leagueFindingTitle(finding)}\n${leagueFindingBody(finding)}\n\nWhat Rat will do:\n${changes[action].map((line) => `- ${line}`).join('\n')}\n\nRat checks everything again before changing anything. Nothing has changed yet.`,
    footer: `Problem ${page + 1}`,
    actions: [
      { id: `league-audit:confirm:${reference}:${page}:${action}`, label: 'Confirm', disabled: false },
      { id: `league-audit:resolve:${reference}:${page}`, label: 'Back', disabled: false },
    ],
  };
}
