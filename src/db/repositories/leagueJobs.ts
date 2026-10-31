import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type LeagueJobStatus =
  | 'QUEUED'
  | 'LOADING'
  | 'VALIDATING'
  | 'APPLYING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'BLOCKED_REVIEW'
  | 'RETRYING'
  | 'RECONCILIATION_REQUIRED'
  | 'FAILED';
export type LeagueJobType = 'transaction' | 'repair' | 'account-replacement' | 'targeted' | 'panel' | 'dirty' | 'audit' | 'heartbeat';
export function isLeagueMutationJob(type: LeagueJobType): boolean {
  return type === 'transaction' || type === 'repair' || type === 'account-replacement';
}
export const leagueJobPriority: Record<LeagueJobType, number> = {
  transaction: 1,
  repair: 1,
  'account-replacement': 1,
  targeted: 2,
  panel: 3,
  dirty: 4,
  audit: 5,
  heartbeat: 6,
};
export type LeagueJob = {
  reference: string;
  guildId: string;
  type: LeagueJobType;
  priority: number;
  payload: unknown;
  status: LeagueJobStatus;
  dedupeKey: string;
  attemptCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  availableAt: string;
  lastError: string | null;
  result: unknown;
};
type Row = {
  reference: string;
  guild_id: string;
  type: LeagueJobType;
  priority: number;
  payload_json: string;
  status: LeagueJobStatus;
  dedupe_key: string;
  attempt_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  available_at: string;
  last_error: string | null;
  result_json: string | null;
};
function decode(row: Row): LeagueJob {
  return {
    reference: row.reference,
    guildId: row.guild_id,
    type: row.type,
    priority: row.priority,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    dedupeKey: row.dedupe_key,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    availableAt: row.available_at,
    lastError: row.last_error,
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}
export function getLeagueJob(db: Database.Database, reference: string): LeagueJob | undefined {
  const row = db.prepare('SELECT * FROM league_jobs WHERE reference = ?').get(reference) as Row | undefined;
  return row && decode(row);
}
export function enqueueLeagueJob(
  db: Database.Database,
  input: { guildId: string; type: LeagueJobType; payload: unknown; dedupeKey: string; now?: Date; delayMs?: number },
): LeagueJob {
  return db.transaction(() => {
    const existingJob = getLeagueJobByDedupe(db, input.guildId, input.dedupeKey);
    const existing = existingJob
      ? (db.prepare('SELECT * FROM league_jobs WHERE reference=?').get(existingJob.reference) as Row)
      : undefined;
    if (existing) {
      const background = !isLeagueMutationJob(input.type);
      if (background && ['LOADING', 'VALIDATING', 'APPLYING', 'VERIFYING'].includes(existing.status)) {
        releaseBackgroundDedupe(db, existing.reference);
      } else {
        return decode(existing);
      }
    }
    if (input.type === 'transaction') {
      const payload = input.payload as { actorUserId: string; selections: string; expectedPlanFingerprint: string };
      const active = db
        .prepare(
          `SELECT * FROM league_jobs WHERE guild_id=? AND type='transaction' AND status IN ('QUEUED','RETRYING','LOADING','VALIDATING','APPLYING','VERIFYING') AND json_extract(payload_json,'$.actorUserId')=? AND json_extract(payload_json,'$.selections')=? AND json_extract(payload_json,'$.expectedPlanFingerprint')=?`,
        )
        .get(input.guildId, payload.actorUserId, payload.selections, payload.expectedPlanFingerprint) as
        Row | undefined;
      if (active) {
        db.prepare('INSERT INTO league_job_approvals VALUES(?,?,?)').run(
          input.guildId,
          input.dedupeKey,
          active.reference,
        );
        return decode(active);
      }
    }
    const now = input.now ?? new Date();
    const reference = `YSL-JOB-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
    db.prepare(
      `INSERT INTO league_jobs(reference,guild_id,type,priority,payload_json,status,dedupe_key,created_at,available_at) VALUES(?,?,?,?,?,'QUEUED',?,?,?)`,
    ).run(
      reference,
      input.guildId,
      input.type,
      leagueJobPriority[input.type],
      JSON.stringify(input.payload),
      input.dedupeKey,
      now.toISOString(),
      new Date(now.getTime() + (input.delayMs ?? 0)).toISOString(),
    );
    return getLeagueJob(db, reference)!;
  })();
}
/** Read-only proof: a fully completed, explicitly linked retry resolves only a
 * blocked attempt that has no evidence of an external mutation of its own.
 * Stored outcomes stay untouched, including for records from older releases.
 */
export function completedLeagueTransactionSuccessor(db: Database.Database, job: LeagueJob): string | undefined {
  if (job.type !== 'transaction' || job.status !== 'BLOCKED_REVIEW') return;
  const selections = (job.payload as { selections?: unknown } | null)?.selections;
  if (typeof selections !== 'string') return;
  let parsed: unknown;
  try { parsed = JSON.parse(selections); } catch { return; }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.some(value => typeof value !== 'string' || !value)
    || !['trade', 'drop', 'self-drop', 'pickup', 'rename', 'departure'].includes(parsed[0])) return;
  const row = db.prepare(`SELECT later.reference FROM league_jobs original
    JOIN league_jobs later ON later.guild_id=original.guild_id AND later.type='transaction'
      AND later.sequence>original.sequence AND later.status='COMPLETED'
      AND json_extract(later.payload_json,'$.originalBlockedReference')=original.reference
      AND json_extract(later.payload_json,'$.selections')=json_extract(original.payload_json,'$.selections')
    JOIN league_transactions canonical ON canonical.reference=later.reference
      AND canonical.guild_id=original.guild_id AND canonical.status='completed' AND canonical.kind=?
    WHERE original.reference=? AND original.guild_id=? AND original.type='transaction' AND original.status='BLOCKED_REVIEW'
      AND json_extract(original.payload_json,'$.selections')=?
      AND NOT EXISTS(SELECT 1 FROM league_transactions t WHERE t.reference=original.reference)
      AND NOT EXISTS(SELECT 1 FROM league_audit_repairs r WHERE r.reference=original.reference)
      AND NOT EXISTS(SELECT 1 FROM league_account_replacements r WHERE r.reference=original.reference)
      AND NOT EXISTS(SELECT 1 FROM league_account_replacement_evidence e WHERE e.job_reference=original.reference)
      AND NOT EXISTS(SELECT 1 FROM league_reconciliation_tickets t WHERE t.reference=original.reference AND t.status='open')
    ORDER BY later.sequence LIMIT 1`).get(parsed[0], job.reference, job.guildId, selections) as { reference: string } | undefined;
  return row?.reference;
}
export function transitionLeagueJob(
  db: Database.Database,
  reference: string,
  status: LeagueJobStatus,
  options: { error?: string; result?: unknown; availableAt?: Date } = {},
): void {
  db.prepare(
    `UPDATE league_jobs SET status=?, last_error=?, result_json=COALESCE(?,result_json), available_at=COALESCE(?,available_at), completed_at=CASE WHEN ? IN ('COMPLETED','BLOCKED_REVIEW','RECONCILIATION_REQUIRED','FAILED') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE reference=?`,
  ).run(
    status,
    options.error ?? null,
    options.result === undefined ? null : JSON.stringify(options.result),
    options.availableAt?.toISOString() ?? null,
    status,
    reference,
  );
}
export function claimLeagueJob(
  db: Database.Database,
  guildId: string,
  presentation: boolean,
  now: Date,
): LeagueJob | undefined {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM league_jobs WHERE guild_id=? AND status IN ('QUEUED','RETRYING') AND available_at<=? AND (type IN ('panel','heartbeat')) = ? AND NOT EXISTS (SELECT 1 FROM league_jobs active WHERE active.guild_id=league_jobs.guild_id AND active.status IN ('LOADING','VALIDATING','APPLYING','VERIFYING') AND (active.type IN ('panel','heartbeat')) = ?) ORDER BY priority,sequence LIMIT 1`,
      )
      .get(guildId, now.toISOString(), presentation ? 1 : 0, presentation ? 1 : 0) as Row | undefined;
    if (!row) return undefined;
    const claimed = db
      .prepare(
        `UPDATE league_jobs SET status='LOADING', attempt_count=attempt_count+1, started_at=? WHERE reference=? AND status IN ('QUEUED','RETRYING')`,
      )
      .run(now.toISOString(), row.reference).changes;
    return claimed ? getLeagueJob(db, row.reference) : undefined;
  })();
}
export function recoverLeagueJobs(db: Database.Database, guildId: string): LeagueJob[] {
  const rows = db
    .prepare(`SELECT * FROM league_jobs WHERE guild_id=? AND status IN ('LOADING','VALIDATING','APPLYING','VERIFYING')`)
    .all(guildId) as Row[];
  return rows.map(decode);
}
/** Presentation inventory includes work in progress as well as staff-review failures. */
export function listUnfinishedLeagueMutationJobs(db: Database.Database, guildId: string): LeagueJob[] {
  return (db.prepare(`SELECT * FROM league_jobs WHERE guild_id=? AND dismissed_at IS NULL
    AND type IN ('transaction','repair','account-replacement') AND status <> 'COMPLETED' ORDER BY sequence`).all(guildId) as Row[])
    .map(decode).filter(job => !completedLeagueTransactionSuccessor(db, job));
}
export function listActionableLeagueJobs(db: Database.Database, guildId: string): LeagueJob[] {
  return (
    db
      .prepare(
        `SELECT * FROM league_jobs WHERE guild_id=? AND dismissed_at IS NULL AND status IN ('BLOCKED_REVIEW','RECONCILIATION_REQUIRED','FAILED') ORDER BY sequence`,
      )
      .all(guildId) as Row[]
  ).map(decode).filter(job => !completedLeagueTransactionSuccessor(db, job));
}
// Background work can be scheduled again after completion; mutation keys are never recycled.
export function releaseBackgroundDedupe(db: Database.Database, reference: string): void {
  db.prepare(
    `UPDATE league_jobs SET dedupe_key=reference WHERE reference=? AND type NOT IN ('transaction','repair','account-replacement')`,
  ).run(reference);
}

export function getLeagueJobByDedupe(db: Database.Database, guildId: string, dedupeKey: string): LeagueJob | undefined {
  const row = db
    .prepare(
      'SELECT * FROM league_jobs WHERE guild_id=? AND (dedupe_key=? OR reference IN (SELECT reference FROM league_job_approvals WHERE guild_id=? AND dedupe_key=?))',
    )
    .get(guildId, dedupeKey, guildId, dedupeKey) as Row | undefined;
  return row && decode(row);
}

export function stopCleanLeagueRetries(db: Database.Database, guildId: string): void {
  db.prepare(
    `UPDATE league_jobs SET status='COMPLETED', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),dedupe_key=reference,result_json='{"skipped":"clean"}' WHERE guild_id=? AND type='dirty' AND status IN ('QUEUED','RETRYING')`,
  ).run(guildId);
}

export function dismissResolvedBackgroundFailures(db: Database.Database, job: LeagueJob): void {
  if (isLeagueMutationJob(job.type)) return;
  const types = job.type === 'panel' || job.type === 'heartbeat' ? ['panel', 'heartbeat'] : [job.type];
  for (const type of types)
    db.prepare(
      `UPDATE league_jobs SET dismissed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE guild_id=? AND type=? AND status='FAILED' AND (?='audit' OR payload_json=?)`,
    ).run(job.guildId, type, type, JSON.stringify(job.payload));
}
export function dismissResolvedRepairReviews(db: Database.Database, guildId: string, findings: string[]): void {
  const jobs = listActionableLeagueJobs(db, guildId).filter(
    (job) => job.type === 'repair' && job.status === 'BLOCKED_REVIEW'
      && !db.prepare('SELECT 1 FROM league_account_replacement_evidence WHERE job_reference=?').get(job.reference),
  );
  for (const job of jobs)
    if (!findings.includes((job.payload as { expectedFinding: string }).expectedFinding)) {
      db.prepare("UPDATE league_jobs SET dismissed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE reference=?").run(
        job.reference,
      );
    }
}
