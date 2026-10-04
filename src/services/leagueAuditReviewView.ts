export type LeagueAuditReviewAction = { id: string; label: string; disabled: boolean };
export type LeagueAuditReviewView = {
  title: string;
  description: string;
  footer: string;
  actions: LeagueAuditReviewAction[];
};

export type LeagueAuditResolutionAction = 'use-discord-name' | 'use-league-name' | 'use-roster-name' | 'repair-roles' | 'sync-public-roster' | 'mark-inactive';

export function buildLeagueAuditRepairReply(
  result: { status: 'clean' | 'dirty' | 'error'; issues: string[] },
  reference: string,
): string {
  if (result.status === 'error') {
    return `Repair completed, but Ratatoskr could not refresh the audit card because Discord or a roster sheet was temporarily unavailable. The repair was saved, and the audit will retry automatically. Reference: ${reference}`;
  }
  if (result.status === 'clean') {
    return `Repair completed. Ratatoskr refreshed the audit card; no issues remain. Reference: ${reference}`;
  }
  return `Repair completed. Ratatoskr refreshed the audit card; ${result.issues.length} issue${result.issues.length === 1 ? '' : 's'} remain. Reference: ${reference}`;
}

function categoryFor(finding: string): string {
  if (finding.includes('Discord name now:') && finding.includes('Current Rosters sheet:') && finding.includes('Player Name History sheet:')) return 'Player names';
  if (finding.includes('Current Rosters:') && finding.includes('Player Name History:') && finding.includes('Make the names match.')) return 'Player names';
  if (finding.includes('no longer in the Discord server')) return 'Departures and inactive players';
  if (/Discord .*role|role in Discord|Discord division|Discord team/i.test(finding)) return 'Discord roles';
  if (/public roster/i.test(finding)) return 'Public roster';
  return 'Managed sheets';
}

function canResolveInDiscord(finding: string): boolean {
  return categoryFor(finding) !== 'Managed sheets';
}

export function buildLeagueAuditReviewView(findings: string[], requestedPage: number, reference: string): LeagueAuditReviewView {
  const page = Math.max(0, Math.min(requestedPage, Math.max(0, findings.length - 1)));
  const finding = findings[page] ?? 'This audit no longer has any open issues.';
  const resolvable = canResolveInDiscord(finding);
  return {
    title: `League Roster Audit — ${categoryFor(finding)}`,
    description: `${finding}${resolvable ? '' : '\n\nThis needs a manual sheet review because Ratatoskr cannot safely choose the correct value.'}`,
    footer: `Issue ${findings.length ? page + 1 : 0} of ${findings.length}`,
    actions: [
      { id: `league-audit:page:${reference}:${Math.max(0, page - 1)}`, label: 'Previous', disabled: page === 0 },
      { id: `league-audit:resolve:${reference}:${page}`, label: 'Resolve this issue', disabled: !resolvable },
      { id: `league-audit:page:${reference}:${Math.min(Math.max(0, findings.length - 1), page + 1)}`, label: 'Next', disabled: page >= findings.length - 1 },
    ],
  };
}

export function buildLeagueAuditResolutionView(
  finding: string,
  page: number,
  reference: string,
): LeagueAuditReviewView {
  const back = { id: `league-audit:page:${reference}:${page}`, label: 'Back', disabled: false };
  if (categoryFor(finding) === 'Player names') {
    return {
      title: 'Update player name',
      description: `${finding}\n\nDiscord is the source for active player names. Preview the exact sheet update next. No changes have been made.`,
      footer: `Issue ${page + 1}`,
      actions: [
        { id: `league-audit:choice:${reference}:${page}:use-discord-name`, label: 'Preview Discord name update', disabled: false },
        back,
      ],
    };
  }
  if (categoryFor(finding) === 'Discord roles') {
    return {
      title: 'Resolve Discord roles',
      description: `${finding}\n\nRatatoskr can make the managed team, division, and Free Agent roles match the managed sheets. No changes have been made.`,
      footer: `Issue ${page + 1}`,
      actions: [
        { id: `league-audit:choice:${reference}:${page}:repair-roles`, label: 'Use managed sheets', disabled: false },
        back,
      ],
    };
  }
  if (categoryFor(finding) === 'Public roster') {
    return {
      title: 'Resolve public roster',
      description: `${finding}\n\nRatatoskr can update only this public roster block from Current Rosters and Player Name History. No changes have been made.`,
      footer: `Issue ${page + 1}`,
      actions: [
        { id: `league-audit:choice:${reference}:${page}:sync-public-roster`, label: 'Use managed roster', disabled: false },
        back,
      ],
    };
  }
  if (finding.includes('listed as a free agent but is no longer in the Discord server')) {
    return {
      title: 'Resolve departed free agent',
      description: `${finding}\n\nRatatoskr can mark this player inactive in Player Name History and remove them from the public free-agent list. No changes have been made.`,
      footer: `Issue ${page + 1}`,
      actions: [
        { id: `league-audit:choice:${reference}:${page}:mark-inactive`, label: 'Mark inactive', disabled: false },
        back,
      ],
    };
  }
  return {
    title: 'Resolve departure',
    description: `${finding}\n\nRun \`/transaction departure\` and select this player. That existing preview lets you choose an optional replacement before anything changes.`,
    footer: `Issue ${page + 1}`,
    actions: [back],
  };
}

export function buildLeagueAuditConfirmationView(
  finding: string,
  page: number,
  reference: string,
  action: LeagueAuditResolutionAction,
): LeagueAuditReviewView {
  const discordName = finding.match(/Discord name now: “([^”]*)”/)?.[1] ?? 'the current Discord name';
  const historyName = finding.match(/Player Name History sheet: “([^”]*)”/)?.[1] ?? 'the previous name';
  const explanation: Record<LeagueAuditResolutionAction, string> = {
    'use-discord-name': `Discord currently shows “${discordName}”. Ratatoskr will update Current Rosters, Player Name History, and the matching public roster to that name. It will keep “${historyName}” in name history.`,
    'use-league-name': 'Ratatoskr will update Current Rosters to the Player Name History value and repair the matching public roster cell only if needed.',
    'use-roster-name': 'Ratatoskr will make the Current Rosters value the official league name, update the public roster, and preserve the previous official name as history.',
    'repair-roles': 'Ratatoskr will remove conflicting managed league roles and apply the team, division, and Free Agent roles recorded in the managed sheets.',
    'sync-public-roster': 'Ratatoskr will update only the affected public roster block from Current Rosters and Player Name History.',
    'mark-inactive': 'Ratatoskr will mark the departed free agent inactive in Player Name History and remove them from the public free-agent list.',
  };
  return {
    title: action === 'use-discord-name' ? 'Confirm Discord name update' : 'Confirm audit repair',
    description: `${finding}\n\n${explanation[action]}\n\nRatatoskr will recheck every source before writing. No changes have been made.`,
    footer: `Issue ${page + 1}`,
    actions: [
      { id: `league-audit:confirm:${reference}:${page}:${action}`, label: action === 'use-discord-name' ? 'Update to Discord name' : 'Confirm repair', disabled: false },
      { id: `league-audit:resolve:${reference}:${page}`, label: 'Back', disabled: false },
    ],
  };
}
