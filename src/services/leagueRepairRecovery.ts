import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { auditLeagueRoster, type DiscordLeagueMember } from '../domain/leagueOperations.js';
import {
  getLeagueAuditRepair,
  getLeagueRepairResolution,
  recordLeagueRepairResolution,
  type LeagueAuditRepair,
} from '../db/repositories/leagueAuditRepairs.js';
import { resolveOpenLeagueReconciliationTickets } from '../db/repositories/leagueOperations.js';
import { getLeagueJob, transitionLeagueJob } from '../db/repositories/leagueJobs.js';
import { acquireLeagueTransaction } from './leagueOperationCoordinator.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import type { LoadedLeagueSnapshot } from './leagueSheets.js';
import { LeagueJobBlockedError } from './leagueJobWorker.js';

export type RepairRecoveryPreview = { repair: LeagueAuditRepair; fingerprint: string; findings: string[] };
type RecoveryInput = {
  db: Database.Database;
  operationScope: object;
  guildId: string;
  freeAgentRoleId: string;
  members: { getMembers(): Promise<DiscordLeagueMember[]> };
  sheets: { load(members: DiscordLeagueMember[], freeAgentRoleId: string): Promise<LoadedLeagueSnapshot> };
};
const previews = new WeakMap<object, Map<string, (reference: string) => Promise<RepairRecoveryPreview>>>();
export function registerLeagueRepairRecovery(input: RecoveryInput): void {
  let guilds = previews.get(input.operationScope);
  if (!guilds) {
    guilds = new Map();
    previews.set(input.operationScope, guilds);
  }
  guilds.set(input.guildId, (reference) => previewLeagueRepairRecovery(input, reference));
}
export function previewRegisteredLeagueRepairRecovery(scope: object, guildId: string, reference: string) {
  const preview = previews.get(scope)?.get(guildId);
  if (!preview) throw new Error('League recovery is not ready. Try again after startup.');
  return preview(reference);
}
async function inspect(input: RecoveryInput, reference: string): Promise<RepairRecoveryPreview> {
  const repair = getLeagueAuditRepair(input.db, reference);
  if (!repair || repair.guildId !== input.guildId || repair.status !== 'reconciliation_required')
    throw new LeagueJobBlockedError('BLOCKED_REVIEW', 'This repair is no longer awaiting reconciliation.');
  const loaded = await input.sheets.load(await input.members.getMembers(), input.freeAgentRoleId);
  const findings = humanizeLeagueAuditIssues(loaded.snapshot, auditLeagueRoster(loaded.snapshot));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ repair, snapshot: { ...loaded.snapshot,
      discordMembers: [...loaded.snapshot.discordMembers].sort((a, b) => a.discordId.localeCompare(b.discordId))
        .map((member) => ({ ...member, roleIds: [...member.roleIds].sort() })),
    } }))
    .digest('hex');
  return { repair, fingerprint, findings };
}
export async function previewLeagueRepairRecovery(
  input: RecoveryInput,
  reference: string,
): Promise<RepairRecoveryPreview> {
  const release = await acquireLeagueTransaction(input.operationScope, input.guildId);
  try {
    return await inspect(input, reference);
  } finally {
    release();
  }
}
export async function reconcileLeagueRepairRecord(
  input: RecoveryInput & {
    reference: string;
    expectedFingerprint: string;
    actorUserId: string;
  },
): Promise<void> {
  const release = await acquireLeagueTransaction(input.operationScope, input.guildId);
  try {
    if (getLeagueRepairResolution(input.db, input.guildId, input.reference)) return;
    const preview = await inspect(input, input.reference);
    if (preview.fingerprint !== input.expectedFingerprint || preview.findings.length)
      throw new LeagueJobBlockedError(
        'BLOCKED_REVIEW',
        'League state changed or still has findings. Review a fresh recovery preview and resolve the current issues first.',
      );
    input.db.transaction(() => {
      // This is an administrator's reconciliation acknowledgement, not a claim
      // that the interrupted write or its historical outcome succeeded.
      recordLeagueRepairResolution(input.db, {
        reference: input.reference,
        guildId: input.guildId,
        actorUserId: input.actorUserId,
        fingerprint: preview.fingerprint,
        verification: preview,
      });
      resolveOpenLeagueReconciliationTickets(input.db, input.guildId);
      const job = getLeagueJob(input.db, input.reference);
      if (job?.guildId === input.guildId && job.status === 'RECONCILIATION_REQUIRED')
        transitionLeagueJob(input.db, input.reference, 'COMPLETED', { result: { manuallyReconciled: true } });
    })();
  } finally {
    release();
  }
}
