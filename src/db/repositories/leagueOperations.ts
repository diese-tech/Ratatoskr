import type Database from 'better-sqlite3';

export type LeagueTransactionStatus =
  | 'applying_discord'
  | 'applying_sheets'
  | 'announcement_pending'
  | 'completed'
  | 'failed'
  | 'reconciliation_required';

export type LeagueTransaction = {
  reference: string;
  guildId: string;
  kind: 'trade' | 'drop' | 'pickup' | 'rename';
  actorUserId: string;
  payload: unknown;
  status: LeagueTransactionStatus;
  announcementId: string | null;
  errorMessage: string | null;
  reconciliationAlertedAt: string | null;
};

type TransactionRow = {
  reference: string;
  guild_id: string;
  kind: LeagueTransaction['kind'];
  actor_user_id: string;
  payload_json: string;
  status: LeagueTransactionStatus;
  announcement_id: string | null;
  error_message: string | null;
  reconciliation_alerted_at: string | null;
};

function toTransaction(row: TransactionRow): LeagueTransaction {
  return {
    reference: row.reference,
    guildId: row.guild_id,
    kind: row.kind,
    actorUserId: row.actor_user_id,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    announcementId: row.announcement_id,
    errorMessage: row.error_message,
    reconciliationAlertedAt: row.reconciliation_alerted_at,
  };
}

export function hasSuccessfulLeagueAudit(db: Database.Database, guildId: string, auditDate: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM league_daily_audits
    WHERE guild_id = ? AND audit_date = ? AND status = 'passed'`).get(guildId, auditDate));
}

export function recordLeagueAudit(db: Database.Database, input: {
  guildId: string;
  auditDate: string;
  status: 'passed' | 'failed';
  issues: string[];
}): void {
  db.prepare(`INSERT INTO league_daily_audits (guild_id, audit_date, status, issues_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, audit_date) DO UPDATE SET
      status = excluded.status,
      issues_json = excluded.issues_json,
      completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .run(input.guildId, input.auditDate, input.status, JSON.stringify(input.issues));
}

export function createLeagueTransaction(db: Database.Database, input: {
  reference: string;
  guildId: string;
  kind: LeagueTransaction['kind'];
  actorUserId: string;
  payload: unknown;
}): void {
  db.prepare(`INSERT INTO league_transactions
    (reference, guild_id, kind, actor_user_id, payload_json, status)
    VALUES (?, ?, ?, ?, ?, 'applying_discord')`)
    .run(input.reference, input.guildId, input.kind, input.actorUserId, JSON.stringify(input.payload));
}

export function getLeagueTransaction(db: Database.Database, reference: string): LeagueTransaction | undefined {
  const row = db.prepare('SELECT * FROM league_transactions WHERE reference = ?').get(reference) as TransactionRow | undefined;
  return row ? toTransaction(row) : undefined;
}

export function listPendingLeagueAnnouncements(db: Database.Database): LeagueTransaction[] {
  const rows = db.prepare(`SELECT * FROM league_transactions
    WHERE status = 'announcement_pending' ORDER BY created_at, reference`).all() as TransactionRow[];
  return rows.map(toTransaction);
}

export function listInterruptedLeagueTransactions(db: Database.Database): LeagueTransaction[] {
  const rows = db.prepare(`SELECT * FROM league_transactions
    WHERE status IN ('applying_discord', 'applying_sheets')
      OR (status = 'reconciliation_required' AND reconciliation_alerted_at IS NULL)
    ORDER BY created_at, reference`).all() as TransactionRow[];
  return rows.map(toTransaction);
}

export function transitionLeagueTransaction(
  db: Database.Database,
  reference: string,
  expected: LeagueTransactionStatus,
  next: LeagueTransactionStatus,
  patch: { announcementId?: string; errorMessage?: string } = {},
): boolean {
  return db.prepare(`UPDATE league_transactions SET
      status = ?,
      announcement_id = COALESCE(?, announcement_id),
      error_message = COALESCE(?, error_message),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE reference = ? AND status = ?`)
    .run(next, patch.announcementId ?? null, patch.errorMessage ?? null, reference, expected).changes === 1;
}

export function markLeagueTransactionReconciliationRequired(
  db: Database.Database,
  reference: string,
  errorMessage: string,
): void {
  db.prepare(`UPDATE league_transactions SET
      status = 'reconciliation_required', error_message = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE reference = ? AND status <> 'completed'`).run(errorMessage, reference);
}

export function markLeagueTransactionReconciliationAlerted(db: Database.Database, reference: string): void {
  db.prepare(`UPDATE league_transactions SET
      reconciliation_alerted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE reference = ? AND status = 'reconciliation_required' AND reconciliation_alerted_at IS NULL`).run(reference);
}
