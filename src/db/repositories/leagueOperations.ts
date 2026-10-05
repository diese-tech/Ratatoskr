import { randomUUID } from 'node:crypto';
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
  kind: 'trade' | 'drop' | 'pickup' | 'rename' | 'departure' | 'self-drop';
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

export type LeagueReconciliationTicket = {
  reference: string;
  guildId: string;
  actorUserId: string;
  fingerprint: string;
  summary: string;
  status: 'open' | 'resolved';
  alertedAt: string | null;
};

type ReconciliationTicketRow = {
  reference: string;
  guild_id: string;
  actor_user_id: string;
  fingerprint: string;
  summary: string;
  status: 'open' | 'resolved';
  alerted_at: string | null;
};

function toReconciliationTicket(row: ReconciliationTicketRow): LeagueReconciliationTicket {
  return {
    reference: row.reference,
    guildId: row.guild_id,
    actorUserId: row.actor_user_id,
    fingerprint: row.fingerprint,
    summary: row.summary,
    status: row.status,
    alertedAt: row.alerted_at,
  };
}

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

export function createOrGetLeagueReconciliationTicket(db: Database.Database, input: {
  reference: string;
  guildId: string;
  actorUserId: string;
  fingerprint: string;
  summary: string;
}): LeagueReconciliationTicket {
  const existing = db.prepare(`SELECT * FROM league_reconciliation_tickets
    WHERE guild_id = ? AND fingerprint = ? AND status = 'open'
    ORDER BY created_at LIMIT 1`).get(input.guildId, input.fingerprint) as ReconciliationTicketRow | undefined;
  if (existing) return toReconciliationTicket(existing);
  db.prepare(`INSERT INTO league_reconciliation_tickets
    (reference, guild_id, actor_user_id, fingerprint, summary)
    VALUES (?, ?, ?, ?, ?)`).run(input.reference, input.guildId, input.actorUserId, input.fingerprint, input.summary);
  return toReconciliationTicket(db.prepare('SELECT * FROM league_reconciliation_tickets WHERE reference = ?')
    .get(input.reference) as ReconciliationTicketRow);
}

export function listUndeliveredLeagueReconciliationTickets(db: Database.Database): LeagueReconciliationTicket[] {
  return (db.prepare(`SELECT * FROM league_reconciliation_tickets
    WHERE status = 'open' AND alerted_at IS NULL ORDER BY created_at, reference`).all() as ReconciliationTicketRow[])
    .map(toReconciliationTicket);
}

export function markLeagueReconciliationTicketAlerted(db: Database.Database, reference: string): void {
  db.prepare(`UPDATE league_reconciliation_tickets SET
      alerted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE reference = ? AND status = 'open' AND alerted_at IS NULL`).run(reference);
}

export function resolveOpenLeagueReconciliationTickets(db: Database.Database, guildId: string): number {
  return db.prepare(`UPDATE league_reconciliation_tickets SET
      status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE guild_id = ? AND status = 'open'
      AND NOT EXISTS (SELECT 1 FROM league_audit_repairs r
        WHERE r.reference = league_reconciliation_tickets.reference
          AND r.status IN ('applying', 'reconciliation_required'))
      AND NOT EXISTS (SELECT 1 FROM league_transactions t
        WHERE t.reference = league_reconciliation_tickets.reference
          AND t.status IN ('applying_discord', 'applying_sheets', 'announcement_pending', 'reconciliation_required'))`).run(guildId).changes;
}

export function listResolvedLeagueAlertReferences(db: Database.Database, guildId: string): string[] {
  return (db.prepare(`SELECT reference FROM (
    SELECT reference FROM league_reconciliation_tickets WHERE guild_id = ? AND status = 'resolved' AND alerted_at IS NOT NULL
    UNION SELECT reference FROM league_transactions WHERE guild_id = ? AND status IN ('completed', 'failed') AND reconciliation_alerted_at IS NOT NULL
  ) resolved WHERE NOT EXISTS (
    SELECT 1 FROM league_alert_cleanup c WHERE c.guild_id = ? AND c.reference = resolved.reference
  )`).all(guildId, guildId, guildId) as Array<{reference: string}>).map((row) => row.reference);
}

export function markLeagueAlertCleaned(db: Database.Database, guildId: string, reference: string): void {
  db.prepare(`INSERT OR IGNORE INTO league_alert_cleanup (guild_id, reference, cleaned_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(guildId, reference);
}

export function getLeagueReconciliationTicket(
  db: Database.Database,
  reference: string,
): LeagueReconciliationTicket | undefined {
  const row = db.prepare('SELECT * FROM league_reconciliation_tickets WHERE reference = ?')
    .get(reference) as ReconciliationTicketRow | undefined;
  return row ? toReconciliationTicket(row) : undefined;
}

export function saveLeagueTransactionPreview(db: Database.Database, input: {
  guildId: string;
  actorUserId: string;
  intentKey: string;
  planFingerprint: string;
}): void {
  db.prepare(`INSERT INTO league_transaction_previews
      (guild_id, actor_user_id, intent_key, plan_fingerprint, approval_reference)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, actor_user_id, intent_key) DO UPDATE SET
      plan_fingerprint = excluded.plan_fingerprint, approval_reference = excluded.approval_reference,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .run(input.guildId, input.actorUserId, input.intentKey, input.planFingerprint, randomUUID());
}

export function getLeagueTransactionPreviewFingerprint(
  db: Database.Database,
  guildId: string,
  actorUserId: string,
  intentKey: string,
): string | undefined {
  const row = db.prepare(`SELECT plan_fingerprint FROM league_transaction_previews
    WHERE guild_id = ? AND actor_user_id = ? AND intent_key = ?`)
    .get(guildId, actorUserId, intentKey) as { plan_fingerprint: string } | undefined;
  return row?.plan_fingerprint;
}

export function deleteLeagueTransactionPreview(
  db: Database.Database,
  guildId: string,
  actorUserId: string,
  intentKey: string,
): void {
  db.prepare(`DELETE FROM league_transaction_previews
    WHERE guild_id = ? AND actor_user_id = ? AND intent_key = ?`)
    .run(guildId, actorUserId, intentKey);
}

export function getLeaguePreviewApproval(db: Database.Database, guildId: string, actorUserId: string, intentKey: string): string | undefined {
  const row = db.prepare('SELECT COALESCE(approval_reference,plan_fingerprint) AS approval FROM league_transaction_previews WHERE guild_id=? AND actor_user_id=? AND intent_key=?').get(guildId,actorUserId,intentKey) as {approval:string} | undefined;
  return row?.approval;
}
export function listOpenLeagueReconciliationTickets(db: Database.Database, guildId: string): LeagueReconciliationTicket[] {
  return (db.prepare("SELECT * FROM league_reconciliation_tickets WHERE guild_id=? AND status='open'").all(guildId) as ReconciliationTicketRow[]).map(toReconciliationTicket);
}

export function listLeagueMutationProblems(db: Database.Database, guildId: string): string[] {
  const rows = db.prepare(`SELECT reference FROM league_transactions WHERE guild_id=? AND status='reconciliation_required' UNION SELECT reference FROM league_audit_repairs WHERE guild_id=? AND status='reconciliation_required'`).all(guildId,guildId) as Array<{reference:string}>;
  return rows.map(row=>row.reference);
}

export function hasPendingLeagueDeliveries(db: Database.Database, guildId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM league_transactions WHERE guild_id=? AND status='announcement_pending' LIMIT 1").get(guildId));
}

export function wasLeagueAlertCleaned(db: Database.Database, guildId: string, reference: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM league_alert_cleanup WHERE guild_id=? AND reference=?').get(guildId, reference));
}
