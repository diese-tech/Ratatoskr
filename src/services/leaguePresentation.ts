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
  if (/permission|authorization|access.*(denied|revoked)|not editable|role hierarchy/i.test(message))
    return 'The person or Rat no longer has the access needed for this action. Ask an admin to check permissions.';
  if (/429|quota|rate.?limit|throttl|cooldown|asked.*wait/i.test(message))
    return 'Discord or Google Sheets asked Rat to wait. Check the saved action’s status with staff; do not repeat it.';
  if (/503|temporarily unavailable/i.test(message)) return 'Discord or Google Sheets was temporarily unavailable.';
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

/** Locally generated validation messages may already be readable. Historical
 * and external failures must use savedLeagueErrorMessage instead. */
export function leagueValidationMessage(message: string): string {
  return /snapshot|reconcil|fingerprint|canonical|managed|hierarchy|payload|mutation|durable|gateway|schema|linkage|attest|convergence/i.test(message)
    ? savedLeagueErrorMessage(message) : message;
}
