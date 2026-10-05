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
export type LeagueJobType = 'transaction' | 'repair' | 'targeted' | 'panel' | 'dirty' | 'audit' | 'heartbeat';
export const leagueJobPriority: Record<LeagueJobType, number> = {
  transaction: 1,
  repair: 1,
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
      const background = !['transaction', 'repair'].includes(input.type);
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
      db.prepare(
        `UPDATE league_jobs SET dismissed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE guild_id=? AND type='transaction' AND status='BLOCKED_REVIEW' AND json_extract(payload_json,'$.actorUserId')=? AND json_extract(payload_json,'$.selections')=?`,
      ).run(input.guildId, payload.actorUserId, payload.selections);
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
export function listActionableLeagueJobs(db: Database.Database, guildId: string): LeagueJob[] {
  return (
    db
      .prepare(
        `SELECT * FROM league_jobs WHERE guild_id=? AND dismissed_at IS NULL AND status IN ('BLOCKED_REVIEW','RECONCILIATION_REQUIRED','FAILED') ORDER BY sequence`,
      )
      .all(guildId) as Row[]
  ).map(decode);
}
// Background work can be scheduled again after completion; mutation keys are never recycled.
export function releaseBackgroundDedupe(db: Database.Database, reference: string): void {
  db.prepare(
    `UPDATE league_jobs SET dedupe_key=reference WHERE reference=? AND type NOT IN ('transaction','repair')`,
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
  if (job.type === 'transaction' || job.type === 'repair') return;
  const types = job.type === 'panel' || job.type === 'heartbeat' ? ['panel', 'heartbeat'] : [job.type];
  for (const type of types)
    db.prepare(
      `UPDATE league_jobs SET dismissed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE guild_id=? AND type=? AND status='FAILED' AND (?='audit' OR payload_json=?)`,
    ).run(job.guildId, type, type, JSON.stringify(job.payload));
}
export function dismissResolvedRepairReviews(db: Database.Database, guildId: string, findings: string[]): void {
  const jobs = listActionableLeagueJobs(db, guildId).filter(
    (job) => job.type === 'repair' && job.status === 'BLOCKED_REVIEW',
  );
  for (const job of jobs)
    if (!findings.includes((job.payload as { expectedFinding: string }).expectedFinding)) {
      db.prepare("UPDATE league_jobs SET dismissed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE reference=?").run(
        job.reference,
      );
    }
}
