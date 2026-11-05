import { z } from 'zod';
import {
  buildDeparturePlan,
  buildReinstatementPlan,
  type ReinstatementSource,
  buildStaffRenamePlan,
  buildDropPlan,
  buildPickupPlan,
  buildSelfDropPlan,
  buildTradePlan,
  buildOneWayTradePlan,
  type LeagueMutationPlan,
  type LeagueSnapshot,
} from '../domain/leagueOperations.js';
import { parseLeagueDivision } from '../domain/leagueDivisions.js';
export type LeagueTransactionIntent = {
  selections: string;
  actorUserId: string;
  actorName: string;
  approvedAt?: string;
  expectedPlanFingerprint: string;
};
export function buildLeagueIntentPlan(selections: string, snapshot: LeagueSnapshot, source?: ReinstatementSource): LeagueMutationPlan {
  const selection = parseReinstatementSelection(selections);
  if (selection) {
    if (!source) throw new Error('A freshly verified original exit is required.');
    return buildReinstatementPlan(snapshot, selection, source);
  }
  const tuple = JSON.parse(selections) as [string, string, string | null, string?];
  const [kind, first, second, chosen] = tuple;
  // An optional fourth element picks the targeted membership (#200); older intents have none.
  const division = chosen === undefined ? undefined : parseLeagueDivision(chosen);
  switch (kind) {
    case 'trade-one-way':
      if (typeof first !== 'string' || !first || typeof second !== 'string' || !second || tuple.length !== 3)
        throw new Error('Invalid saved one-way trade.');
      return buildOneWayTradePlan(snapshot, first, second);
    case 'trade':
      return buildTradePlan(snapshot, first, second!, division);
    case 'drop':
      return buildDropPlan(snapshot, first, second ?? undefined, division);
    case 'self-drop':
      return buildSelfDropPlan(snapshot, first, second ?? undefined, division);
    case 'departure':
      return buildDeparturePlan(snapshot, first, second ?? undefined, division);
    case 'pickup':
      return buildPickupPlan(snapshot, first, second!);
    case 'rename':
      return buildStaffRenamePlan(snapshot, first, second!);
    default:
      throw new Error('Unknown stored league transaction intent.');
  }
}

const reinstateSchema = z.object({
  version: z.literal(1), kind: z.literal('reinstate'), playerId: z.string().min(1),
  sourceReference: z.string().min(1), teamRoleId: z.string().min(1), returnStatus: z.literal('Player'),
  // Keep legacy timing markers readable; timing is never required for approval.
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), overrides: z.array(z.enum(['timing', 'discipline', 'roster-count'])),
  preserveFutureSanction: z.literal(true), reason: z.string().trim().max(300).optional(),
}).strict();
export function parseReinstatementSelection(selections: string) {
  const parsed: unknown = JSON.parse(selections);
  if (Array.isArray(parsed)) return undefined;
  return reinstateSchema.parse(parsed);
}
