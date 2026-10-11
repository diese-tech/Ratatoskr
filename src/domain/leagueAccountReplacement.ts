import {
  auditLeagueRoster,
  LeagueMutationValidationError,
  type DiscordLeagueMember,
  type LeagueNameRow,
  type LeagueRosterRow,
  type LeagueSnapshot,
  type PublicRosterChange,
} from './leagueOperations.js';

export type AccountReplacementMember = DiscordLeagueMember & { guildId: string; bot: boolean };
export type AccountReplacementRoleChange = {
  discordId: string;
  managedRoleIds: string[];
  before: string[];
  after: string[];
  remove: string[];
  add: string[];
};
export type LeagueAccountReplacementPlan = {
  oldDiscordId: string;
  newDiscordId: string;
  rosterBefore: LeagueRosterRow;
  rosterAfter: LeagueRosterRow;
  oldNameBefore: LeagueNameRow;
  oldNameAfter: LeagueNameRow;
  newName: LeagueNameRow;
  publicChanges: PublicRosterChange[];
  roles: AccountReplacementRoleChange[];
  manualReview: string[];
  preservedHistory: { nameRows: LeagueNameRow[]; transactions: 'unchanged'; accountObservations: 'distinct' };
};
export type AccountReplacementPlanInput = {
  guildId: string;
  snapshot: LeagueSnapshot;
  oldDiscordId: string;
  newDiscordId: string;
  oldMember: AccountReplacementMember | null;
  newMember: AccountReplacementMember | null;
  newNameSheetRow: number;
};

export function buildLeagueAccountReplacementPlan(input: AccountReplacementPlanInput): LeagueAccountReplacementPlan {
  const { snapshot, oldDiscordId, newDiscordId, newMember } = input;
  const reject = (message: string): never => { throw new LeagueMutationValidationError(message); };
  if (!oldDiscordId.trim() || !newDiscordId.trim() || oldDiscordId === newDiscordId)
    reject('Account replacement requires two distinct Discord IDs.');
  if (!newMember || newMember.discordId !== newDiscordId || newMember.guildId !== input.guildId || newMember.bot)
    reject('The replacement account must be a current non-bot member of this guild.');
  if (input.oldMember && (input.oldMember.discordId !== oldDiscordId || input.oldMember.guildId !== input.guildId || input.oldMember.bot))
    reject('The old Discord account identity does not match this guild.');
  const rosters = snapshot.rosters.filter((row) => row.discordId === oldDiscordId);
  const names = snapshot.names.filter((row) => row.discordId === oldDiscordId && row.nameStatus === 'Current Discord Name');
  if (rosters.length !== 1 || names.length !== 1)
    reject('The old account must own exactly one roster assignment and one current name record.');
  if (snapshot.rosters.some((row) => row.discordId === newDiscordId) || snapshot.names.some((row) => row.discordId === newDiscordId))
    reject('The replacement account already has league identity records. Reconcile that conflict first.');
  const rosterBefore = rosters[0]!;
  const oldNameBefore = names[0]!;
  if (oldNameBefore.division !== rosterBefore.division || oldNameBefore.franchise !== rosterBefore.franchise
    || oldNameBefore.leagueStatus !== rosterBefore.rosterStatus || oldNameBefore.currentLeagueName !== rosterBefore.player)
    reject('The old current name and roster assignment disagree.');
  const teams = snapshot.teams.filter((entry) => entry.active && entry.teamRoleId === rosterBefore.teamRoleId);
  if (teams.length !== 1) reject('The roster team is not configured unambiguously.');
  const team = teams[0]!;
  if (rosterBefore.division !== team.division || rosterBefore.franchise !== team.franchise || rosterBefore.team !== team.teamRole)
    reject('The old roster row does not match its configured team.');
  if (!Number.isInteger(input.newNameSheetRow) || input.newNameSheetRow < 6
    || snapshot.names.some((row) => row.sheetRow === input.newNameSheetRow)) reject('The proposed current-name row is occupied.');
  const target = newMember!;
  if (!target.displayName.trim()) reject('The replacement Discord display name is empty.');
  const teamRoles = snapshot.teams.filter((entry) => entry.active).map((entry) => entry.teamRoleId);
  for (const member of [target, ...(input.oldMember ? [input.oldMember] : [])]) {
    const assigned = member.roleIds.filter((roleId) => teamRoles.includes(roleId));
    if (assigned.length > 1 || assigned.some((roleId) => roleId !== team.teamRoleId))
      reject('An account holds a conflicting managed team role.');
  }
  const managedRoleIds = [...new Set(snapshot.teams.filter((entry) => entry.active)
    .flatMap((entry) => [entry.teamRoleId, entry.divisionRoleId]).concat(snapshot.freeAgentRoleId))].sort();
  const roleChange = (member: AccountReplacementMember, after: string[]): AccountReplacementRoleChange => {
    const before = member.roleIds.filter((id) => managedRoleIds.includes(id)).sort();
    return { discordId: member.discordId, managedRoleIds, before, after: [...after].sort(),
      remove: before.filter((id) => !after.includes(id)), add: after.filter((id) => !before.includes(id)) };
  };
  const plan: LeagueAccountReplacementPlan = {
    oldDiscordId, newDiscordId,
    rosterBefore: { ...rosterBefore },
    rosterAfter: { ...rosterBefore, discordId: newDiscordId, player: target.displayName },
    oldNameBefore: { ...oldNameBefore },
    oldNameAfter: { ...oldNameBefore, nameStatus: 'Previous / Alternate' },
    newName: { ...oldNameBefore, sheetRow: input.newNameSheetRow, discordId: newDiscordId,
      currentLeagueName: target.displayName, knownName: target.displayName },
    publicChanges: oldNameBefore.currentLeagueName === target.displayName ? [] : [{
      division: team.division, area: 'team', group: team.franchise,
      from: rosterBefore.player, to: target.displayName,
    }],
    roles: [roleChange(target, [team.teamRoleId, team.divisionRoleId]),
      ...(input.oldMember ? [roleChange(input.oldMember, [])] : [])],
    manualReview: ['Review captain/staff access manually; only configured team, division and Free Agent roles are managed.',
      ...[target, ...(input.oldMember ? [input.oldMember] : [])].flatMap((member) => {
        const unmanaged = member.roleIds.filter((id) => id !== input.guildId && !managedRoleIds.includes(id)).sort();
        return unmanaged.length ? [`Account ${member.discordId}: leave unmapped access roles ${unmanaged.join(', ')} for manual review.`] : [];
      })],
    preservedHistory: { nameRows: snapshot.names.filter((row) => row.discordId === oldDiscordId && row.sheetRow !== oldNameBefore.sheetRow)
      .map((row) => ({ ...row })), transactions: 'unchanged', accountObservations: 'distinct' },
  };
  const after = projectLeagueAccountReplacement(snapshot, plan);
  const problems = auditLeagueRoster(after);
  if (problems.length) reject(`Account replacement cannot reconcile this league state: ${problems.join(' ')}`);
  return plan;
}

export function projectLeagueAccountReplacement(snapshot: LeagueSnapshot, plan: LeagueAccountReplacementPlan): LeagueSnapshot {
  const after = structuredClone(snapshot);
  after.rosters = after.rosters.map((row) => row.sheetRow === plan.rosterBefore.sheetRow ? { ...plan.rosterAfter } : row);
  after.names = after.names.map((row) => row.sheetRow === plan.oldNameBefore.sheetRow ? { ...plan.oldNameAfter } : row);
  after.names.push({ ...plan.newName });
  for (const role of plan.roles) {
    const member = after.discordMembers.find((entry) => entry.discordId === role.discordId);
    if (member) member.roleIds = member.roleIds.filter((id) => !role.managedRoleIds.includes(id)).concat(role.after);
  }
  for (const change of plan.publicChanges) {
    const names = after.publicRosters[change.division]?.teams[change.group];
    const index = names?.indexOf(change.from) ?? -1;
    if (index < 0) throw new LeagueMutationValidationError('The owned public roster name is missing.');
    names![index] = change.to;
  }
  return after;
}
