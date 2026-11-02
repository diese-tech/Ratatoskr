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
  type LeagueMutationPlan,
  type LeagueSnapshot,
} from '../domain/leagueOperations.js';
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
