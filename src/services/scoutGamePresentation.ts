export function scoutGameName(setup: { workflow?: 'scout' | 'inhouse'; divisionDisplayName: string }): string {
  return setup.workflow === 'inhouse' ? 'Inhouse' : `${setup.divisionDisplayName} Scout`;
}

/** Only used for rejected edits that did not write a player change. */
export function scoutRosterChangeFailure(outcome: string): string {
  const reasons: Record<string, string> = {
    stale: 'The game or roster changed. Open its latest roster controls and try again.',
    duplicate: 'That player is already on a team. Choose someone else.',
    ineligible: 'That player can no longer take this spot. Check their signup and access to the game.',
    occupied: 'That spot is already filled. Choose another spot or replace its player.',
    off_role_confirmation: 'The player did not sign up for this role. Review the warning and confirm before adding them.',
  };
  const reason = Object.hasOwn(reasons, outcome) ? reasons[outcome]
    : 'Open the game’s latest roster controls and check the players before trying again.';
  return `No player change was made. ${reason}`;
}
