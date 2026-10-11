import type Database from 'better-sqlite3';
import { LeagueMutationValidationError } from '../../domain/leagueOperations.js';

export type AccountReplacementStatus = 'prepared' | 'applying_admin' | 'applying_public' | 'applying_discord'
  | 'verifying' | 'completed' | 'failed' | 'reconciliation_required';
export type AccountReplacementRecord = {
  reference: string; guildId: string; oldDiscordId: string; newDiscordId: string; actorUserId: string;
  beforeFingerprint: string; afterFingerprint: string; plan: unknown; status: AccountReplacementStatus;
  verification: unknown; error: string | null;
};
type Row = { reference: string; guild_id: string; old_discord_id: string; new_discord_id: string; actor_user_id: string;
  before_fingerprint: string; after_fingerprint: string; plan_json: string; status: AccountReplacementStatus;
  verification_json: string | null; error_message: string | null };
export function assertNoUnresolvedAccountReplacement(db: Database.Database, guildId: string, exceptReference = ''): void {
  if (db.prepare(`SELECT 1 FROM league_account_replacements WHERE guild_id=? AND reference<>?
    AND status NOT IN ('prepared','completed','failed') LIMIT 1`).get(guildId, exceptReference))
    throw new LeagueMutationValidationError('An account replacement needs explicit reconciliation before further league mutations.');
}
export function getAccountReplacement(db: Database.Database, guildId: string, reference: string): AccountReplacementRecord | undefined {
  const r = db.prepare('SELECT * FROM league_account_replacements WHERE guild_id=? AND reference=?').get(guildId, reference) as Row | undefined;
  return r && { reference: r.reference, guildId: r.guild_id, oldDiscordId: r.old_discord_id, newDiscordId: r.new_discord_id,
    actorUserId: r.actor_user_id, beforeFingerprint: r.before_fingerprint, afterFingerprint: r.after_fingerprint,
    plan: JSON.parse(r.plan_json), status: r.status, verification: r.verification_json ? JSON.parse(r.verification_json) : null, error: r.error_message };
}
export function assertAccountReplacementAvailable(db: Database.Database, guildId: string, oldId: string, newId: string, reference = ''): void {
  assertNoUnresolvedAccountReplacement(db, guildId, reference);
  const rows = db.prepare(`SELECT * FROM league_account_replacements WHERE guild_id=? AND reference<>? AND status<>'failed'
    AND (old_discord_id IN (?,?) OR new_discord_id IN (?,?))`).all(guildId, reference, oldId, newId, oldId, newId) as Row[];
  // A completed incoming linkage permits a later replacement of the same continuing player.
  if (rows.some((row) => row.status !== 'completed' || row.new_discord_id !== oldId || row.old_discord_id === newId))
    throw new LeagueMutationValidationError('An account already has a conflicting replacement linkage or pending operation.');
}
export function createAccountReplacement(db: Database.Database, record: Omit<AccountReplacementRecord, 'status' | 'verification' | 'error'>,
  evidenceJobs: string[]): AccountReplacementRecord {
  return db.transaction(() => {
    assertAccountReplacementAvailable(db, record.guildId, record.oldDiscordId, record.newDiscordId, record.reference);
    db.prepare(`INSERT INTO league_account_replacements(reference,guild_id,old_discord_id,new_discord_id,actor_user_id,
      before_fingerprint,after_fingerprint,plan_json,status) VALUES(?,?,?,?,?,?,?,?,'prepared')`).run(
      record.reference, record.guildId, record.oldDiscordId, record.newDiscordId, record.actorUserId,
      record.beforeFingerprint, record.afterFingerprint, JSON.stringify(record.plan));
    for (const job of evidenceJobs) db.prepare('INSERT INTO league_account_replacement_evidence VALUES(?,?)').run(record.reference, job);
    return getAccountReplacement(db, record.guildId, record.reference)!;
  })();
}
export function transitionAccountReplacement(db: Database.Database, guildId: string, reference: string, status: AccountReplacementStatus,
  evidence?: unknown, error?: string): void {
  const changed = db.prepare(`UPDATE league_account_replacements SET status=?,verification_json=COALESCE(?,verification_json),error_message=?,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE guild_id=? AND reference=? AND status NOT IN ('completed','failed')`).run(
      status, evidence === undefined ? null : JSON.stringify(evidence), error ?? null, guildId, reference).changes;
  if (changed !== 1) throw new Error('Account replacement lifecycle changed before its result could be recorded.');
}
