import type Database from 'better-sqlite3';

export type LeagueAuditRepairAction =
  | 'use-discord-name'
  | 'use-league-name'
  | 'use-roster-name'
  | 'repair-roles'
  | 'sync-public-roster'
  | 'mark-inactive';

export type LeagueAuditRepair = {
  reference: string;
  guildId: string;
  auditReference: string;
  actorUserId: string;
  finding: string;
  action: LeagueAuditRepairAction;
  status: 'applying' | 'completed' | 'failed' | 'reconciliation_required';
  errorMessage: string | null;
};

type Row = {
  reference: string;
  guild_id: string;
  audit_reference: string;
  actor_user_id: string;
  finding: string;
  action: LeagueAuditRepairAction;
  status: LeagueAuditRepair['status'];
  error_message: string | null;
};

function toRepair(row: Row): LeagueAuditRepair {
  return {
    reference: row.reference,
    guildId: row.guild_id,
    auditReference: row.audit_reference,
    actorUserId: row.actor_user_id,
    finding: row.finding,
    action: row.action,
    status: row.status,
    errorMessage: row.error_message,
  };
}

export function createLeagueAuditRepair(db: Database.Database, input: {
  reference: string;
  guildId: string;
  auditReference: string;
  actorUserId: string;
  finding: string;
  action: LeagueAuditRepairAction;
}): void {
  db.prepare(`INSERT INTO league_audit_repairs
    (reference, guild_id, audit_reference, actor_user_id, finding, action, status)
    VALUES (?, ?, ?, ?, ?, ?, 'applying')`)
    .run(input.reference, input.guildId, input.auditReference, input.actorUserId, input.finding, input.action);
}

export function getLeagueAuditRepair(db: Database.Database, reference: string): LeagueAuditRepair | undefined {
  const row = db.prepare('SELECT * FROM league_audit_repairs WHERE reference = ?').get(reference) as Row | undefined;
  return row ? toRepair(row) : undefined;
}

export function listIncompleteLeagueAuditRepairs(db: Database.Database): LeagueAuditRepair[] {
  const rows = db.prepare(`SELECT * FROM league_audit_repairs
    WHERE status IN ('applying', 'reconciliation_required') ORDER BY created_at, reference`).all() as Row[];
  return rows.map(toRepair);
}

export function completeLeagueAuditRepair(db: Database.Database, reference: string): boolean {
  return db.prepare(`UPDATE league_audit_repairs SET status = 'completed',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE reference = ? AND status = 'applying'`).run(reference).changes === 1;
}

export function failLeagueAuditRepair(db: Database.Database, reference: string, errorMessage: string): boolean {
  return db.prepare(`UPDATE league_audit_repairs SET status = 'failed', error_message = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE reference = ? AND status = 'applying'`).run(errorMessage, reference).changes === 1;
}

export function markLeagueAuditRepairReconciliationRequired(
  db: Database.Database,
  reference: string,
  errorMessage: string,
): void {
  db.prepare(`UPDATE league_audit_repairs SET status = 'reconciliation_required', error_message = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE reference = ? AND status <> 'completed'`).run(errorMessage, reference);
}

export function getLeagueRepairResolution(db: Database.Database, guildId: string, reference: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM league_repair_resolutions WHERE reference=? AND guild_id=?').get(reference, guildId));
}

export function recordLeagueRepairResolution(db: Database.Database, input: {
  reference: string; guildId: string; actorUserId: string; fingerprint: string; verification: unknown;
}): void {
  db.prepare(`INSERT INTO league_repair_resolutions(reference,guild_id,actor_user_id,verification_fingerprint,verification_json)
    VALUES(?,?,?,?,?)`).run(input.reference, input.guildId, input.actorUserId, input.fingerprint, JSON.stringify(input.verification));
  const changed = db.prepare(`UPDATE league_audit_repairs SET status='failed', error_message=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE reference=? AND guild_id=? AND status='reconciliation_required'`)
    .run(`Manually reconciled by ${input.actorUserId}; fresh surfaces verified. No mutation replayed.`, input.reference, input.guildId).changes;
  if (changed !== 1) throw new Error('Repair reconciliation state changed before it could be saved.');
}
