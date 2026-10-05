import {
  buildDeparturePlan,
  buildDiscordRenamePlan,
  buildDropPlan,
  buildPickupPlan,
  buildSelfDropPlan,
  buildTradePlan,
  type LeagueMutationPlan,
  type LeagueSnapshot,
} from '../domain/leagueOperations.js';
export type LeagueTransactionIntent = {
  selections: string;
  actorUserId: string;
  actorName: string;
  expectedPlanFingerprint: string;
};
export function buildLeagueIntentPlan(selections: string, snapshot: LeagueSnapshot): LeagueMutationPlan {
  const [kind, first, second] = JSON.parse(selections) as [string, string, string | null];
  switch (kind) {
    case 'trade':
      return buildTradePlan(snapshot, first, second!);
    case 'drop':
      return buildDropPlan(snapshot, first, second ?? undefined);
    case 'self-drop':
      return buildSelfDropPlan(snapshot, first, second ?? undefined);
    case 'departure':
      return buildDeparturePlan(snapshot, first, second ?? undefined);
    case 'pickup':
      return buildPickupPlan(snapshot, first, second!);
    case 'rename':
      return buildDiscordRenamePlan(snapshot, first, second!);
    default:
      throw new Error('Unknown stored league transaction intent.');
  }
}
