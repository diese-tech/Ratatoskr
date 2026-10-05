import { LeagueAuditRepairStaleError } from './leagueAuditResolution.js';

export type LeagueAuditRunResult = {
  status: 'clean' | 'dirty' | 'error';
  issues: string[];
  cardId?: string;
};

export async function executeRepairAndRefresh(
  showProcessing: () => Promise<void>,
  executeRepair: () => Promise<{ reference: string }>,
  refreshAudit: () => Promise<LeagueAuditRunResult>,
): Promise<
  | { kind: 'repaired'; reference: string; audit: LeagueAuditRunResult }
  | { kind: 'stale-refreshed'; audit: LeagueAuditRunResult }
> {
  await showProcessing();
  try {
    const repair = await executeRepair();
    return { kind: 'repaired', reference: repair.reference, audit: await refreshAudit() };
  } catch (error) {
    if (!(error instanceof LeagueAuditRepairStaleError)) throw error;
    return { kind: 'stale-refreshed', audit: await refreshAudit() };
  }
}
