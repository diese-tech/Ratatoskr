/** Display names only. Stored job/action names remain the workflow authority. */
export function leagueActionLabel(action: string): string {
  const labels: Record<string, string> = {
    transaction: 'Player change', repair: 'Roster fix', 'account-replacement': 'Discord account change',
    reinstate: 'Reinstatement', reinstatement: 'Reinstatement', trade: 'Trade', drop: 'Drop', 'self-drop': 'Self-drop', pickup: 'Pickup', rename: 'Name change', departure: 'Departure',
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
    SUPERSEDED: 'Resolved by a later action',
  };
  return Object.hasOwn(labels, status) ? labels[status]! : 'Check the saved action';
}

/** Saved failures can contain old wording or external diagnostics. Explain a
 * recognized cause; never display an unknown technical error as user copy. */
export function savedLeagueErrorMessage(message: string | null | undefined): string {
  if (!message || message === 'No saved error.') return 'No problem was recorded.';
  // Older audit failures prefix every sheet name, regardless of the actual
  // blocker. Classify the specific finding, preserving the known no-write result.
  const legacyPrefix = 'Ratatoskr made no changes. Reconcile Discord, Current Rosters, Player Name History, and the public roster, then retry. ';
  if (message.startsWith(legacyPrefix)) {
    const cause = savedLeagueErrorMessage(message.slice(legacyPrefix.length));
    const guidance = /Some changes may already have happened|Some changes may already|may be partial/i.test(cause)
      ? 'The roster check needs staff review. Ask staff to check the current roster problems and saved action.' : cause;
    return `${guidance} No changes were made by this attempt.`;
  }
  if (/is in Current Rosters but is no longer in the Discord server\. Confirm whether this is a departure| left the server\nThey’re still on /.test(message))
    return 'A rostered player is no longer in the Discord server. Ask staff to review their departure before changing the roster.';
  if (/exactly one current[- ]name record|multiple current name records/i.test(message))
    return 'This player needs exactly one current name in our records. An admin needs to fix that in the league spreadsheet.';
  if (/more than one current roster assignment|exactly one Current Rosters assignment/i.test(message))
    return 'This player needs to be on exactly one team in our records. An admin needs to fix that in the league spreadsheet.';
  if (/permission|authorization|access.*(denied|revoked)|not editable|role hierarchy|privileged|integration-owned/i.test(message))
    return 'The person or Rat no longer has the access needed for this action. Ask an admin to check permissions.';
  if (/429|quota|rate.?limit|throttl|cooldown|asked.*wait/i.test(message))
    return 'Discord or Google Sheets asked Rat to wait. Check the saved action’s status with staff; do not repeat it.';
  if (/503|temporarily unavailable/i.test(message)) return 'Discord or Google Sheets was temporarily unavailable.';
  if (/Only a proven pre-write blocked transaction can receive a fresh preview\./.test(message))
    return 'Rat cannot show a new preview for this saved action. Ask staff to check its status and records; do not repeat it.';
  if (/preview|fingerprint|changed.*(writing|confirmation)|source changed/i.test(message))
    return 'The information changed after the preview. Check the latest records before approving another action.';
  if (/current.name|Player Name History/i.test(message)) return 'The player’s names in our records need checking. An admin needs to fix that in the league spreadsheet.';
  if (/ambiguous|unambiguously|inactive team|League Teams/i.test(message)) return 'Rat can’t tell which team or role is right. An admin needs to check the team setup in the league spreadsheet.';
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
  'The selected role is not an active YSL team role.',
  'A traded player name is already used in the destination roster area.',
  'That player name is already used in the destination free-agent area.',
  'That player name is already used in the destination roster area.',
  "That is already the player's Current League Name.",
  'That league name is already used by another player in this roster area.',
  'The current Discord nickname could not be verified. Request a fresh preview.',
  'The new player nickname must contain 1–32 characters without control characters.',
  'That player does not have a usable Discord display name.',
  'Cross-division trades are not supported.',
  'Both players are already on the same team.',
  'The player is already on the receiving team.',
  'The player does not have their current team role.',
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
  if (message.startsWith('The new league name must exactly match the player’s current Discord display name: '))
    return 'The league name must match the player’s current Discord name. Copy that name from Discord and preview the change.';
  if (readableLeagueValidationMessages.has(message)
    || /^<@[A-Za-z0-9_-]+> is (?:not rostered on an active YSL team|not registered in Player Name History)\.$/.test(message)) return message;
  if (message.startsWith('No empty slot was found') || message.startsWith('The receiving roster cell contains a value or formula.'))
    return 'Rat could not find an empty receiving roster slot. Ask staff to check the receiving team’s public roster, then preview again.';
  const guidance = savedLeagueErrorMessage(message);
  if (outcome === 'read-only' && /Some changes may already have happened/i.test(guidance))
    return 'Rat could not prepare this player change. Ask staff to check the selected players, roles and league records.';
  return guidance;
}

/** Only for a typed repair failure that guarantees no external write occurred. */
export function leagueRepairNoWriteMessage(message: string): string {
  const manual = /exactly one current[- ]name record|multiple current name records|more than one current roster assignment|ambiguous or inactive team|division role is not configured unambiguously/i.test(message);
  if (manual) return `${savedLeagueErrorMessage(message)} No changes were made.`;
  if (/conflicting player-name issue/i.test(message)) return 'The player’s names disagree. Fix the name problem first, then check the roster page. No changes were made.';
  if (/no longer (?:available for a Discord role repair|has both a Discord account and one current name record)/i.test(message)) return 'This player’s Discord account or name changed. Press Review problems on the League Status card to see the latest problems. No changes were made.';
  if (/does not currently provide a usable display name/i.test(message)) return 'Check the player’s current name in Discord before choosing a name fix. No changes were made.';
  const reason = /changed since this review page opened/i.test(message)
    ? 'The records changed after this review opened.' : 'Rat couldn’t prepare this fix.';
  return `${reason} No changes were made. Press Review problems on the League Status card to see the latest problems, then choose a fix again.`;
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
    case 'repair-roles': return 'The roster is right — fix Discord';
    case 'use-discord-name': return 'Discord is right — update our records';
    case 'use-league-name': return 'Use the name from the name list';
    case 'use-roster-name': return 'Use the name from the team roster';
    case 'sync-public-roster': return 'The roster is right — fix the roster page';
    case 'mark-inactive': return 'They left — mark them inactive';
    default: return 'Review fix';
  }
}
export function leagueFixExplanation(action: string | undefined): string {
  const confirm = 'Nothing changes until you press Confirm.';
  switch (action) {
    case 'repair-roles': return `Which one is right? If our roster is right, Rat changes this player’s Discord team, division and Free Agent roles to match it. The roster stays the same. If Discord is right because a move already happened, use /transaction for that move instead. ${confirm}`;
    case 'use-discord-name': return `Player names come from Discord. Rat copies the Discord name to our records and the roster page, and keeps the old name as a past name. ${confirm}`;
    case 'sync-public-roster': return `Rat updates this roster page so it lists the same players as our roster. ${confirm}`;
    case 'mark-inactive': return `If they’ve left the league, Rat marks them inactive and takes them off the free agent list. ${confirm}`;
    default: return 'Rat can’t fix this one by itself. Ask an admin to fix it in the league spreadsheet.';
  }
}


/** Removal records track individual resources and may be safely retried after review. */
export function leagueRemovalErrorMessage(message: string): string {
  if (/permission|access|hierarchy|privileged|not editable|integration-owned/i.test(message))
    return 'Rat could not remove this item. Ask an admin to check Rat’s permissions and role order, then review the remaining items before running removal again.';
  if (/429|quota|rate.?limit|throttl/i.test(message))
    return 'Discord asked Rat to wait. Wait, then review the remaining items before running removal again.';
  return 'Rat could not confirm this item was removed. Check whether it still exists in Discord, then review the remaining items before running removal again.';
}
