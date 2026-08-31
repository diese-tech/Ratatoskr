import type Database from 'better-sqlite3';
import type { ScoutRole } from '../../domain/index.js';
import type { ScoutRosterSlot, ScoutTeam } from '../../domain/scoutRoster.js';
import type { ScoutRosterSlotRecord, ScoutSetup, ScoutSetupStatus, ScoutSignup } from '../types.js';

type ScoutSetupRow = {
  id: number;
  guild_id: string;
  division_id: number;
  division_key: string;
  division_display_name: string;
  created_by: string;
  signup_channel_id: string;
  results_channel_id: string;
  division_role_id: string;
  solo_emoji_id: string;
  jungle_emoji_id: string;
  mid_emoji_id: string;
  support_emoji_id: string;
  carry_emoji_id: string;
  signup_message_id: string | null;
  start_at: number;
  role_limit: number;
  note: string | null;
  status: ScoutSetupStatus;
  version: number;
  created_at: string;
  updated_at: string;
};

type ScoutSignupRow = {
  id: number;
  setup_id: number;
  user_id: string;
  role: ScoutRole;
  created_at: string;
};

function toScoutSetup(row: ScoutSetupRow): ScoutSetup {
  return {
    id: row.id,
    guildId: row.guild_id,
    divisionId: row.division_id,
    divisionKey: row.division_key,
    divisionDisplayName: row.division_display_name,
    createdBy: row.created_by,
    signupChannelId: row.signup_channel_id,
    resultsChannelId: row.results_channel_id,
    divisionRoleId: row.division_role_id,
    emojiByRole: {
      solo: row.solo_emoji_id,
      jungle: row.jungle_emoji_id,
      mid: row.mid_emoji_id,
      support: row.support_emoji_id,
      carry: row.carry_emoji_id,
    },
    signupMessageId: row.signup_message_id,
    startAt: row.start_at,
    roleLimit: row.role_limit,
    note: row.note,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreateScoutSetupInput = Omit<
  ScoutSetup,
  'id' | 'signupMessageId' | 'status' | 'version' | 'note' | 'createdAt' | 'updatedAt'
> & { note?: string | null };

export function createScoutSetup(db: Database.Database, input: CreateScoutSetupInput): ScoutSetup {
  const row = db
    .prepare(
      `INSERT INTO scout_setups (
         guild_id, division_id, division_key, division_display_name, created_by,
         signup_channel_id, results_channel_id, division_role_id,
         solo_emoji_id, jungle_emoji_id, mid_emoji_id, support_emoji_id, carry_emoji_id,
         start_at, role_limit, note
       ) VALUES (
         @guildId, @divisionId, @divisionKey, @divisionDisplayName, @createdBy,
         @signupChannelId, @resultsChannelId, @divisionRoleId,
         @soloEmojiId, @jungleEmojiId, @midEmojiId, @supportEmojiId, @carryEmojiId,
         @startAt, @roleLimit, @note
       ) RETURNING *`,
    )
    .get({
      ...input,
      soloEmojiId: input.emojiByRole.solo,
      jungleEmojiId: input.emojiByRole.jungle,
      midEmojiId: input.emojiByRole.mid,
      supportEmojiId: input.emojiByRole.support,
      carryEmojiId: input.emojiByRole.carry,
      note: input.note ?? null,
    }) as ScoutSetupRow;
  return toScoutSetup(row);
}

export function getScoutSetupById(db: Database.Database, setupId: number): ScoutSetup | undefined {
  const row = db.prepare('SELECT * FROM scout_setups WHERE id = ?').get(setupId) as ScoutSetupRow | undefined;
  return row ? toScoutSetup(row) : undefined;
}

export function getScoutSetupBySignupMessageId(
  db: Database.Database,
  signupMessageId: string,
): ScoutSetup | undefined {
  const row = db
    .prepare('SELECT * FROM scout_setups WHERE signup_message_id = ?')
    .get(signupMessageId) as ScoutSetupRow | undefined;
  return row ? toScoutSetup(row) : undefined;
}

export function setScoutSetupSignupMessage(
  db: Database.Database,
  setupId: number,
  signupMessageId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE scout_setups
       SET signup_message_id = ?, status = 'open', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'posting' AND signup_message_id IS NULL`,
    )
    .run(signupMessageId, setupId);
  return result.changes === 1;
}

export function markScoutSetupPostingFailed(db: Database.Database, setupId: number): void {
  db.prepare(
    `UPDATE scout_setups SET status = 'posting_failed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND status IN ('posting', 'open')`,
  ).run(setupId);
}

export type AddScoutSignupOutcome =
  | { status: 'added' }
  | { status: 'duplicate' }
  | { status: 'over_limit'; limit: number }
  | { status: 'closed' };

export function addScoutSignup(
  db: Database.Database,
  setupId: number,
  userId: string,
  role: ScoutRole,
): AddScoutSignupOutcome {
  return db.transaction((): AddScoutSignupOutcome => {
    const setup = db.prepare('SELECT role_limit, status FROM scout_setups WHERE id = ?').get(setupId) as
      | { role_limit: number; status: ScoutSetupStatus }
      | undefined;
    if (!setup || !['open', 'roster_ready'].includes(setup.status)) return { status: 'closed' };

    const existing = db
      .prepare('SELECT role FROM scout_signups WHERE setup_id = ? AND user_id = ?')
      .all(setupId, userId) as { role: string }[];
    if (existing.some((row) => row.role === role)) return { status: 'duplicate' };
    if (existing.length >= setup.role_limit) return { status: 'over_limit', limit: setup.role_limit };

    db.prepare('INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, ?, ?)').run(setupId, userId, role);
    return { status: 'added' };
  })();
}

export function removeScoutSignup(
  db: Database.Database,
  setupId: number,
  userId: string,
  role: ScoutRole,
): void {
  db.prepare(
    `DELETE FROM scout_signups
     WHERE setup_id = ? AND user_id = ? AND role = ?
       AND EXISTS (
         SELECT 1 FROM scout_setups
         WHERE id = scout_signups.setup_id AND status IN ('open', 'roster_ready')
       )`,
  ).run(setupId, userId, role);
}

export function listScoutSignups(db: Database.Database, setupId: number): ScoutSignup[] {
  const rows = db
    .prepare('SELECT * FROM scout_signups WHERE setup_id = ? ORDER BY created_at, id')
    .all(setupId) as ScoutSignupRow[];
  return rows.map((row) => ({
    id: row.id,
    setupId: row.setup_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
  }));
}

type ScoutRosterSlotRow = {
  id: number;
  setup_id: number;
  team: ScoutTeam;
  role: ScoutRole;
  user_id: string;
  created_at: string;
  updated_at: string;
};

function assertCompleteScoutRoster(slots: readonly ScoutRosterSlot[]): void {
  if (slots.length !== 10 || new Set(slots.map((slot) => slot.userId)).size !== 10) {
    throw new Error('A scout roster must contain exactly ten unique players.');
  }
}

function insertScoutRosterSlots(db: Database.Database, setupId: number, slots: readonly ScoutRosterSlot[]): void {
  assertCompleteScoutRoster(slots);
  const insert = db.prepare(
    'INSERT INTO scout_roster_slots (setup_id, team, role, user_id) VALUES (?, ?, ?, ?)',
  );
  for (const slot of slots) insert.run(setupId, slot.team, slot.role, slot.userId);
}

export function tryCreateInitialScoutRoster(
  db: Database.Database,
  setupId: number,
  slots: readonly ScoutRosterSlot[],
): boolean {
  return db.transaction(() => {
    const claimed = db
      .prepare(
        `UPDATE scout_setups SET status = 'roster_ready', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'open'`,
      )
      .run(setupId);
    if (claimed.changes !== 1) return false;
    insertScoutRosterSlots(db, setupId, slots);
    return true;
  })();
}

export function listScoutRosterSlots(db: Database.Database, setupId: number): ScoutRosterSlotRecord[] {
  const rows = db
    .prepare('SELECT * FROM scout_roster_slots WHERE setup_id = ? ORDER BY team, role')
    .all(setupId) as ScoutRosterSlotRow[];
  return rows.map((row) => ({
    id: row.id,
    setupId: row.setup_id,
    team: row.team,
    role: row.role,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function replaceScoutRosterIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
  slots: readonly ScoutRosterSlot[],
): boolean {
  return db.transaction(() => {
    assertCompleteScoutRoster(slots);
    const claimed = db
      .prepare(
        `UPDATE scout_setups
         SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'roster_ready' AND version = ?`,
      )
      .run(setupId, expectedVersion);
    if (claimed.changes !== 1) return false;
    db.prepare('DELETE FROM scout_roster_slots WHERE setup_id = ?').run(setupId);
    insertScoutRosterSlots(db, setupId, slots);
    return true;
  })();
}
