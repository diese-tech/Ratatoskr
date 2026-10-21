/** Display names only. Stored job/action names remain the workflow authority. */
export function leagueActionLabel(action: string): string {
  const labels: Record<string, string> = {
    transaction: 'Player change', repair: 'Roster fix', 'account-replacement': 'Discord account change',
    trade: 'Trade', drop: 'Drop', 'self-drop': 'Self-drop', pickup: 'Pickup', rename: 'Name change', departure: 'Departure',
    'use-discord-name': 'Use Discord name', 'use-league-name': 'Use league name', 'use-roster-name': 'Use roster name',
    'repair-roles': 'Fix Discord roles', 'sync-public-roster': 'Update public roster', 'mark-inactive': 'Mark player inactive',
    audit: 'Check rosters', panel: 'Update league message', heartbeat: 'Update league message',
  };
  if (action.startsWith('reconcile ')) return `Check unfinished ${leagueActionLabel(action.slice(10)).toLowerCase()}`;
  return Object.hasOwn(labels, action) ? labels[action]! : 'League action';
}

export function leagueStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    QUEUED: 'Waiting to start', LOADING: 'Checking records', VALIDATING: 'Checking the changes',
    APPLYING: 'Making changes', VERIFYING: 'Checking the result', RETRYING: 'Waiting to try again',
    BLOCKED_REVIEW: 'Waiting for staff review', FAILED: 'Could not finish', COMPLETED: 'Finished',
    RECONCILIATION_REQUIRED: 'Needs checking — some changes may already have happened',
    RECONCILED: 'Checked and closed',
  };
  return Object.hasOwn(labels, status) ? labels[status]! : 'Check the saved action';
}

/** Saved failures can contain old wording or external diagnostics. Explain a
 * recognized cause; never display an unknown technical error as user copy. */
export function savedLeagueErrorMessage(message: string | null | undefined): string {
  if (!message || message === 'No saved error.') return 'No problem was recorded.';
  if (/exactly one current[- ]name record|multiple current name records/i.test(message))
    return 'Player Name History needs exactly one current name for this player. Ask staff to check that sheet and the saved action.';
  if (/more than one current roster assignment|exactly one Current Rosters assignment/i.test(message))
    return 'This player needs one current team entry. Check Current Rosters for missing or duplicate entries.';
  if (/permission|authorization|access.*(denied|revoked)|not editable|role hierarchy|privileged|integration-owned/i.test(message))
    return 'The person or Rat no longer has the access needed for this action. Ask an admin to check permissions.';
  if (/429|quota|rate.?limit|throttl|cooldown|asked.*wait/i.test(message))
    return 'Discord or Google Sheets asked Rat to wait. Check the saved action’s status with staff; do not repeat it.';
  if (/503|temporarily unavailable/i.test(message)) return 'Discord or Google Sheets was temporarily unavailable.';
  if (/Only a proven pre-write blocked transaction can receive a fresh preview\./.test(message))
    return 'Rat cannot show a new preview for this saved action. Ask staff to check its status and records; do not repeat it.';
  if (/preview|fingerprint|changed.*(writing|confirmation)|source changed/i.test(message))
    return 'The information changed after the preview. Check the latest records before approving another action.';
  if (/current.name|Player Name History/i.test(message)) return 'The player’s name records need checking in Player Name History.';
  if (/ambiguous|inactive team|League Teams/i.test(message)) return 'Rat cannot choose the correct team or role. Ask staff to check League Teams.';
  if (/roster audit|Current Rosters|roster.*(mismatch|does not match)/i.test(message))
    return 'The roster records do not agree. Ask staff to review the current roster problems and the saved action.';
  if (/delivery|partial|interrupted|outcome unknown/i.test(message))
    return 'Rat could not confirm how far this action got. Some changes may already have happened. Check the records and posts; do not run it again.';
  return 'This problem needs staff review. Some changes may already have happened. Ask staff to check the records and any saved action; do not repeat it.';
}

/** Validation failures also come from role checks and saved-action review.
 * Unrecognized text must never be presumed suitable for a private reply. */
const readableLeagueValidationMessages = new Set([
  'A trade requires two different players.',
  'Cross-division trades are not supported.',
  'Both players are already on the same team.',
  'The outgoing player cannot replace themselves.',
  'That player is still in the YSL server. Use `/transaction drop` or `/transaction self-drop`.',
  'The selected replacement is not a free agent.',
  'Cross-division replacements are not supported.',
  'The selected replacement does not have the Free Agent role.',
  'The selected player is not a free agent.',
  'Cross-division pickups are not supported.',
  'The selected player does not have the Free Agent role.',
  'League name cannot be blank.',
  'That player is not currently in the Discord server.',
  'This saved action was not found in this server. Check its reference.',
  'Confirm that both Discord accounts belong to the same player.',
]);
export function leagueValidationMessage(message: string, outcome: 'read-only' | 'unknown' = 'unknown'): string {
  if (readableLeagueValidationMessages.has(message)
    || /^<@[A-Za-z0-9_-]+> is (?:not rostered on an active YSL team|not registered in Player Name History)\.$/.test(message)) return message;
  const guidance = savedLeagueErrorMessage(message);
  if (outcome === 'read-only' && /Some changes may already have happened/i.test(guidance))
    return 'Rat could not prepare this player change. Ask staff to check the selected players, roles and league records.';
  return guidance;
}

/** Only for a typed repair failure that guarantees no external write occurred. */
export function leagueRepairNoWriteMessage(message: string): string {
  const reason = /changed since this review page opened/i.test(message)
    ? 'The records changed after this review opened.' : 'Rat could not prepare this repair.';
  return `${reason} No changes were made. Review and fix from the latest League Status message, check the roster problems and review a fresh preview before approving a fix.`;
}

/** A roster check only reads sources; its outcome must not imply a saved write. */
export function leagueAuditReadErrorMessage(message: string): string {
  if (message.startsWith('**What happened:**') || message.startsWith('**What to do:**')) return message;
  if (/^Google Sheets asked Rat to wait/.test(message))
    return 'Google Sheets asked Rat to wait before checking again. No roster changes were made by this check.';
  if (/^Google Sheets is temporarily unavailable/.test(message))
    return 'Google Sheets is temporarily unavailable. No roster changes were made by this check.';
  if (/^Discord asked Rat to wait\. Try checking again in \d+ seconds\. No roster changes were made by this check\.$/.test(message)) return message;
  if (/^Discord asked Rat to wait/.test(message))
    return 'Discord asked Rat to wait before checking again. No roster changes were made by this check.';
  return 'Rat could not check all Discord members and roster sheets. No roster changes were made by this check.';
}

/** Always show league times in Eastern time, including the EST/EDT change. */
export function leagueEasternTime(value: string | Date | null | undefined): string {
  if (!value) return 'Not checked yet';
  // Older SQLite rows use UTC without an explicit offset.
  const source = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? value.replace(' ', 'T') + 'Z' : value;
  const date = source instanceof Date ? source : new Date(source);
  if (!Number.isFinite(date.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
}

export function leagueFixLabel(action: string | undefined): string {
  switch (action) {
    case 'repair-roles': return 'Set Discord roles from roster sheets';
    case 'use-discord-name': return 'Update sheets to Discord name';
    case 'use-league-name': return 'Use name from name history';
    case 'use-roster-name': return 'Use name from team roster';
    case 'sync-public-roster': return 'Update public roster';
    case 'mark-inactive': return 'Remove departed free agent';
    default: return 'Review fix';
  }
}
export function leagueFixExplanation(action: string | undefined): string {
  switch (action) {
    case 'repair-roles': return 'Rat reads Current Rosters and Player Name History in the Admin workbook, then updates the player’s Discord team, division and Free Agent roles to match those sheets. This changes Discord roles; the sheets stay the same. Use this only when the sheets already show the correct assignment. For a new trade, drop or pickup, use /transaction instead.';
    case 'use-discord-name': return 'This copies the player’s current Discord name to the roster sheets and public roster. The old name stays in history.';
    case 'sync-public-roster': return 'This updates the affected team’s public player list to match the roster sheets.';
    case 'mark-inactive': return 'This marks the departed free agent inactive and removes them from the public free-agent list.';
    default: return 'Staff must check the named sheet and correct this problem there.';
  }
}
