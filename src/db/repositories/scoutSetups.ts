import type Database from 'better-sqlite3';
import type { ScoutRole, ScoutSignupRole } from '../../domain/index.js';
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
  operations_channel_id: string | null;
  division_role_id: string;
  eligibility_role_id: string | null;
  game_count: 1 | 2;
  solo_emoji_id: string;
  jungle_emoji_id: string;
  mid_emoji_id: string;
  support_emoji_id: string;
  carry_emoji_id: string;
  fill_emoji_id: string | null;
  signup_message_id: string | null;
  result_message_id: string | null;
  control_message_id: string | null;
  signup_post_reconciled: 0 | 1;
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
  role: ScoutSignupRole;
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
    operationsChannelId: row.operations_channel_id,
    divisionRoleId: row.division_role_id,
    eligibilityRoleId: row.eligibility_role_id,
    gameCount: row.game_count,
    emojiByRole: {
      solo: row.solo_emoji_id,
      jungle: row.jungle_emoji_id,
      mid: row.mid_emoji_id,
      support: row.support_emoji_id,
      carry: row.carry_emoji_id,
      fill: row.fill_emoji_id,
    },
    signupMessageId: row.signup_message_id,
    resultMessageId: row.result_message_id,
    controlMessageId: row.control_message_id,
    signupPostReconciled: row.signup_post_reconciled === 1,
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
  'id' | 'emojiByRole' | 'eligibilityRoleId' | 'gameCount' | 'operationsChannelId' | 'signupMessageId' | 'resultMessageId' | 'controlMessageId' | 'signupPostReconciled' | 'status' | 'version' | 'note' | 'createdAt' | 'updatedAt'
> & {
  emojiByRole: Record<ScoutRole, string> & { fill?: string | null };
  eligibilityRoleId?: string | null;
  operationsChannelId?: string | null;
  note?: string | null;
};

export function createScoutSetup(db: Database.Database, input: CreateScoutSetupInput): ScoutSetup {
  const row = db
    .prepare(
      `INSERT INTO scout_setups (
         guild_id, division_id, division_key, division_display_name, created_by,
         signup_channel_id, results_channel_id, operations_channel_id, division_role_id, eligibility_role_id,
         solo_emoji_id, jungle_emoji_id, mid_emoji_id, support_emoji_id, carry_emoji_id, fill_emoji_id,
         start_at, role_limit, note
       ) VALUES (
         @guildId, @divisionId, @divisionKey, @divisionDisplayName, @createdBy,
         @signupChannelId, @resultsChannelId, @operationsChannelId, @divisionRoleId, @eligibilityRoleId,
         @soloEmojiId, @jungleEmojiId, @midEmojiId, @supportEmojiId, @carryEmojiId, @fillEmojiId,
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
      fillEmojiId: input.emojiByRole.fill ?? null,
      operationsChannelId: input.operationsChannelId ?? null,
      eligibilityRoleId: input.eligibilityRoleId ?? null,
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

export function listPostingScoutSetups(db: Database.Database): ScoutSetup[] {
  const rows = db.prepare("SELECT * FROM scout_setups WHERE status = 'posting' ORDER BY id").all() as ScoutSetupRow[];
  return rows.map(toScoutSetup);
}

export function listActiveScoutSetups(db: Database.Database): ScoutSetup[] {
  const rows = db
    .prepare("SELECT * FROM scout_setups WHERE status IN ('open', 'roster_ready') AND signup_message_id IS NOT NULL ORDER BY id")
    .all() as ScoutSetupRow[];
  return rows.map(toScoutSetup);
}

export function listScoutPublishesNeedingReconciliation(db: Database.Database): ScoutSetup[] {
  const rows = db
    .prepare(
      `SELECT * FROM scout_setups
       WHERE status = 'published'
         AND (result_message_id IS NULL OR signup_post_reconciled = 0)
       ORDER BY id`,
    )
    .all() as ScoutSetupRow[];
  return rows.map(toScoutSetup);
}

export function listTerminalScoutSetupsWithControlPanels(db: Database.Database): ScoutSetup[] {
  const rows = db
    .prepare(
      `SELECT * FROM scout_setups
       WHERE status IN ('published', 'cancelled') AND control_message_id IS NOT NULL
       ORDER BY id`,
    )
    .all() as ScoutSetupRow[];
  return rows.map(toScoutSetup);
}

export function listRosterReadyScoutSetups(db: Database.Database): ScoutSetup[] {
  const rows = db
    .prepare(
      `SELECT * FROM scout_setups
       WHERE status = 'roster_ready'
         AND operations_channel_id IS NOT NULL
       ORDER BY id`,
    )
    .all() as ScoutSetupRow[];
  return rows.map(toScoutSetup);
}

export function listCancelledScoutSetupsNeedingSignupPostReconciliation(
  db: Database.Database,
): ScoutSetup[] {
  const rows = db
    .prepare(
      `SELECT * FROM scout_setups
       WHERE status = 'cancelled'
         AND signup_post_reconciled = 0
         AND signup_message_id IS NOT NULL
       ORDER BY id`,
    )
    .all() as ScoutSetupRow[];
  return rows.map(toScoutSetup);
}

export function setScoutControlMessage(
  db: Database.Database,
  setupId: number,
  controlMessageId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE scout_setups
       SET control_message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'roster_ready'
         AND operations_channel_id IS NOT NULL
         AND control_message_id IS NULL`,
    )
    .run(controlMessageId, setupId);
  return result.changes === 1;
}

export function replaceScoutControlMessage(
  db: Database.Database,
  setupId: number,
  expectedControlMessageId: string,
  controlMessageId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE scout_setups
       SET control_message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'roster_ready'
         AND operations_channel_id IS NOT NULL
         AND control_message_id = ?`,
    )
    .run(controlMessageId, setupId, expectedControlMessageId);
  return result.changes === 1;
}

export function markCancelledScoutSignupPostReconciled(
  db: Database.Database,
  setupId: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE scout_setups
       SET signup_post_reconciled = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'cancelled' AND signup_post_reconciled = 0`,
    )
    .run(setupId);
  return result.changes === 1;
}

export function listCancellableScoutSetups(
  db: Database.Database,
  guildId: string,
  divisionId: number,
): ScoutSetup[] {
  const rows = db
    .prepare(
      `SELECT * FROM scout_setups
       WHERE guild_id = ? AND division_id = ? AND status IN ('open', 'roster_ready')
       ORDER BY start_at, id`,
    )
    .all(guildId, divisionId) as ScoutSetupRow[];
  return rows.map(toScoutSetup);
}

export function listDivisionScoutLifecycleBlockers(db: Database.Database, guildId: string, divisionId: number): ScoutSetup[] {
  const rows = db.prepare(`SELECT * FROM scout_setups
    WHERE guild_id = ? AND division_id = ? AND (
      status IN ('posting', 'open', 'roster_ready') OR
      (status = 'published' AND (result_message_id IS NULL OR signup_post_reconciled = 0))
    ) ORDER BY start_at, id`).all(guildId, divisionId) as ScoutSetupRow[];
  return rows.map(toScoutSetup);
}

export function listOverlappingScoutSetups(
  db: Database.Database,
  guildId: string,
  createdBy: string,
  startAt: number,
): ScoutSetup[] {
  const rows = db.prepare(
    `SELECT * FROM scout_setups
     WHERE guild_id = ? AND created_by = ? AND start_at = ?
       AND status IN ('posting', 'open', 'roster_ready', 'published')
     ORDER BY id`,
  ).all(guildId, createdBy, startAt) as ScoutSetupRow[];
  return rows.map(toScoutSetup);
}

export type CancelScoutSetupOutcome = 'cancelled' | 'published' | 'already_cancelled' | 'stale';

export function cancelScoutSetupIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
): CancelScoutSetupOutcome {
  return db.transaction(() => {
    const setup = db.prepare('SELECT status, version FROM scout_setups WHERE id = ?').get(setupId) as
      | { status: ScoutSetupStatus; version: number }
      | undefined;
    if (!setup || setup.version !== expectedVersion) return 'stale';
    if (setup.status === 'published') return 'published';
    if (setup.status === 'cancelled') return 'already_cancelled';
    if (!['open', 'roster_ready'].includes(setup.status)) return 'stale';
    const result = db
      .prepare(
        `UPDATE scout_setups SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND version = ? AND status IN ('open', 'roster_ready')`,
      )
      .run(setupId, expectedVersion);
    return result.changes === 1 ? 'cancelled' : 'stale';
  })();
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

export function setScoutPostingMessage(
  db: Database.Database,
  setupId: number,
  signupMessageId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE scout_setups
       SET signup_message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'posting' AND signup_message_id IS NULL`,
    )
    .run(signupMessageId, setupId);
  return result.changes === 1;
}

export function replaceScoutPostingMessage(
  db: Database.Database,
  setupId: number,
  expectedSignupMessageId: string,
  signupMessageId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE scout_setups
       SET signup_message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'posting' AND signup_message_id = ?`,
    )
    .run(signupMessageId, setupId, expectedSignupMessageId);
  return result.changes === 1;
}

export function activatePostedScoutSetup(db: Database.Database, setupId: number): boolean {
  const result = db
    .prepare(
      `UPDATE scout_setups
       SET status = 'open', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'posting' AND signup_message_id IS NOT NULL`,
    )
    .run(setupId);
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
  role: ScoutSignupRole,
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
  role: ScoutSignupRole,
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

export function replaceScoutSignups(
  db: Database.Database,
  setupId: number,
  signups: readonly { userId: string; role: ScoutSignupRole }[],
): boolean {
  return db.transaction(() => {
    const setup = db.prepare('SELECT status, role_limit FROM scout_setups WHERE id = ?').get(setupId) as
      | { status: ScoutSetupStatus; role_limit: number }
      | undefined;
    if (!setup || !['open', 'roster_ready'].includes(setup.status)) return false;
    const unique = new Map<string, { userId: string; role: ScoutSignupRole }>();
    const counts = new Map<string, number>();
    for (const signup of signups) {
      const key = `${signup.userId}:${signup.role}`;
      if (unique.has(key)) continue;
      const count = counts.get(signup.userId) ?? 0;
      if (count >= setup.role_limit) continue;
      unique.set(key, signup);
      counts.set(signup.userId, count + 1);
    }
    const acceptedKeys = new Set(unique.keys());
    const existing = db
      .prepare('SELECT user_id, role FROM scout_signups WHERE setup_id = ?')
      .all(setupId) as { user_id: string; role: ScoutSignupRole }[];
    const remove = db.prepare('DELETE FROM scout_signups WHERE setup_id = ? AND user_id = ? AND role = ?');
    for (const signup of existing) {
      if (!acceptedKeys.has(`${signup.user_id}:${signup.role}`)) {
        remove.run(setupId, signup.user_id, signup.role);
      }
    }
    const insert = db.prepare('INSERT OR IGNORE INTO scout_signups (setup_id, user_id, role) VALUES (?, ?, ?)');
    for (const signup of unique.values()) insert.run(setupId, signup.userId, signup.role);
    return true;
  })();
}

type ScoutRosterSlotRow = {
  id: number;
  setup_id: number;
  game_number: number;
  team: ScoutTeam;
  role: ScoutRole;
  user_id: string;
  staff_assigned: number;
  created_at: string;
  updated_at: string;
};

function assertCompleteScoutRoster(slots: readonly ScoutRosterSlot[], gameCount: number): void {
  const expected = gameCount * 10;
  if (slots.length !== expected || new Set(slots.map((slot) => slot.userId)).size !== expected) {
    throw new Error(`A ${gameCount}-game scout roster must contain exactly ${expected} unique players.`);
  }
}

function insertScoutRosterSlots(db: Database.Database, setupId: number, slots: readonly ScoutRosterSlot[]): void {
  const setup = db.prepare('SELECT game_count FROM scout_setups WHERE id = ?').get(setupId) as { game_count: number };
  assertCompleteScoutRoster(slots, setup.game_count);
  const insert = db.prepare(
    'INSERT INTO scout_roster_slots (setup_id, game_number, team, role, user_id) VALUES (?, ?, ?, ?, ?)',
  );
  for (const slot of slots) insert.run(setupId, slot.gameNumber ?? 1, slot.team, slot.role, slot.userId);
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

export function expandScoutRosterToTwoGamesIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
  slots: readonly ScoutRosterSlot[],
): boolean {
  return db.transaction(() => {
    assertCompleteScoutRoster(slots, 2);
    if (slots.some((slot) => slot.gameNumber !== 1 && slot.gameNumber !== 2)) {
      throw new Error('A two-game scout roster must identify every slot as game 1 or game 2.');
    }
    const claimed = db.prepare(
      `UPDATE scout_setups
       SET game_count = 2, version = version + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'roster_ready' AND game_count = 1 AND version = ?`,
    ).run(setupId, expectedVersion);
    if (claimed.changes !== 1) return false;
    db.prepare('DELETE FROM scout_roster_slots WHERE setup_id = ?').run(setupId);
    insertScoutRosterSlots(db, setupId, slots);
    return true;
  })();
}

export function listScoutRosterSlots(db: Database.Database, setupId: number): ScoutRosterSlotRecord[] {
  const rows = db
    .prepare('SELECT * FROM scout_roster_slots WHERE setup_id = ? ORDER BY game_number, team, role')
    .all(setupId) as ScoutRosterSlotRow[];
  return rows.map((row) => ({
    id: row.id,
    setupId: row.setup_id,
    gameNumber: row.game_number,
    team: row.team,
    role: row.role,
    userId: row.user_id,
    staffAssigned: row.staff_assigned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function swapScoutRosterSlotsIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
  firstSlotId: number,
  secondSlotId: number,
  staffOverride: boolean,
): boolean {
  return db.transaction(() => {
    const rows = db
      .prepare('SELECT * FROM scout_roster_slots WHERE setup_id = ? AND id IN (?, ?)')
      .all(setupId, firstSlotId, secondSlotId) as ScoutRosterSlotRow[];
    if (rows.length !== 2 || firstSlotId === secondSlotId) return false;
    const claimed = db
      .prepare(
        `UPDATE scout_setups SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'roster_ready' AND version = ?`,
      )
      .run(setupId, expectedVersion);
    if (claimed.changes !== 1) return false;
    const first = rows.find((row) => row.id === firstSlotId)!;
    const second = rows.find((row) => row.id === secondSlotId)!;
    const update = db.prepare(
      `UPDATE scout_roster_slots
       SET user_id = ?, staff_assigned = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    );
    update.run(second.user_id, staffOverride || second.staff_assigned === 1 ? 1 : 0, first.id);
    update.run(first.user_id, staffOverride || first.staff_assigned === 1 ? 1 : 0, second.id);
    return true;
  })();
}

export type ReplaceScoutRosterSlotOutcome = 'updated' | 'stale' | 'duplicate';

export function replaceScoutRosterSlotIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
  slotId: number,
  userId: string,
  staffAssigned: boolean,
): ReplaceScoutRosterSlotOutcome {
  return db.transaction(() => {
    const slot = db
      .prepare('SELECT id FROM scout_roster_slots WHERE setup_id = ? AND id = ?')
      .get(setupId, slotId);
    if (!slot) return 'stale';
    const duplicate = db
      .prepare('SELECT 1 FROM scout_roster_slots WHERE setup_id = ? AND user_id = ?')
      .get(setupId, userId);
    if (duplicate) return 'duplicate';
    const claimed = db
      .prepare(
        `UPDATE scout_setups SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'roster_ready' AND version = ?`,
      )
      .run(setupId, expectedVersion);
    if (claimed.changes !== 1) return 'stale';
    db.prepare(
      `UPDATE scout_roster_slots SET user_id = ?, staff_assigned = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(userId, staffAssigned ? 1 : 0, slotId);
    return 'updated';
  })();
}

export function withdrawnScoutRosterUserIds(db: Database.Database, setupId: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT slots.user_id
       FROM scout_roster_slots slots
       WHERE slots.setup_id = ? AND slots.staff_assigned = 0
         AND NOT EXISTS (
           SELECT 1 FROM scout_signups signups
           WHERE signups.setup_id = slots.setup_id
             AND signups.user_id = slots.user_id
             AND (signups.role = slots.role OR signups.role = 'fill')
         )
       ORDER BY slots.user_id`,
    )
    .all(setupId) as { user_id: string }[];
  return rows.map((row) => row.user_id);
}

export type ClaimScoutPublishOutcome = 'claimed' | 'stale' | 'withdrawals';

export function claimScoutPublish(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
): ClaimScoutPublishOutcome {
  return db.transaction(() => {
    const setup = db.prepare('SELECT status, version FROM scout_setups WHERE id = ?').get(setupId) as
      | { status: ScoutSetupStatus; version: number }
      | undefined;
    if (!setup || setup.status !== 'roster_ready' || setup.version !== expectedVersion) return 'stale';
    if (withdrawnScoutRosterUserIds(db, setupId).length) return 'withdrawals';
    const result = db
      .prepare(
        `UPDATE scout_setups SET status = 'published', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'roster_ready' AND version = ?`,
      )
      .run(setupId, expectedVersion);
    return result.changes === 1 ? 'claimed' : 'stale';
  })();
}

export function releaseScoutPublishClaim(
  db: Database.Database,
  setupId: number,
  expectedResultMessageId?: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE scout_setups
       SET status = 'roster_ready', result_message_id = NULL, signup_post_reconciled = 0,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'published'
         AND (result_message_id IS NULL OR result_message_id = ?)`,
    )
    .run(setupId, expectedResultMessageId ?? null);
  return result.changes === 1;
}

export function setScoutPendingResultMessage(
  db: Database.Database,
  setupId: number,
  resultMessageId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE scout_setups SET result_message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'published' AND result_message_id IS NULL`,
    )
    .run(resultMessageId, setupId);
  return result.changes === 1;
}

export function markPublishedScoutSignupPostReconciled(
  db: Database.Database,
  setupId: number,
  resultMessageId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE scout_setups SET signup_post_reconciled = 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'published' AND result_message_id = ?
         AND signup_post_reconciled = 0`,
    )
    .run(setupId, resultMessageId);
  return result.changes === 1;
}

export function setScoutResultMessage(db: Database.Database, setupId: number, resultMessageId: string): boolean {
  return db.transaction(() =>
    setScoutPendingResultMessage(db, setupId, resultMessageId) &&
    markPublishedScoutSignupPostReconciled(db, setupId, resultMessageId))();
}

export function replacePublishedScoutRosterSlotIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
  slotId: number,
  userId: string,
): ReplaceScoutRosterSlotOutcome {
  return db.transaction(() => {
    const slot = db.prepare('SELECT id FROM scout_roster_slots WHERE setup_id = ? AND id = ?').get(setupId, slotId);
    if (!slot) return 'stale';
    if (db.prepare('SELECT 1 FROM scout_roster_slots WHERE setup_id = ? AND user_id = ?').get(setupId, userId)) {
      return 'duplicate';
    }
    const claimed = db
      .prepare(
        `UPDATE scout_setups SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'published' AND version = ? AND result_message_id IS NOT NULL`,
      )
      .run(setupId, expectedVersion);
    if (claimed.changes !== 1) return 'stale';
    db.prepare(
      `UPDATE scout_roster_slots SET user_id = ?, staff_assigned = 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(userId, slotId);
    return 'updated';
  })();
}

export function rollbackPublishedScoutRosterReplacement(
  db: Database.Database,
  setupId: number,
  updatedVersion: number,
  slotId: number,
  replacementUserId: string,
  originalUserId: string,
  originalStaffAssigned: boolean,
): boolean {
  return db.transaction(() => {
    const slot = db
      .prepare('SELECT user_id FROM scout_roster_slots WHERE setup_id = ? AND id = ?')
      .get(setupId, slotId) as { user_id: string } | undefined;
    if (!slot || slot.user_id !== replacementUserId) return false;
    const restored = db
      .prepare(
        `UPDATE scout_setups SET version = version - 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'published' AND version = ? AND result_message_id IS NOT NULL`,
      )
      .run(setupId, updatedVersion);
    if (restored.changes !== 1) return false;
    db.prepare(
      `UPDATE scout_roster_slots SET user_id = ?, staff_assigned = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(originalUserId, originalStaffAssigned ? 1 : 0, slotId);
    return true;
  })();
}

export function swapPublishedScoutRosterSlotsIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
  firstSlotId: number,
  secondSlotId: number,
): boolean {
  return db.transaction(() => {
    const rows = db.prepare(
      'SELECT * FROM scout_roster_slots WHERE setup_id = ? AND id IN (?, ?)',
    ).all(setupId, firstSlotId, secondSlotId) as ScoutRosterSlotRow[];
    if (rows.length !== 2 || firstSlotId === secondSlotId) return false;
    const claimed = db.prepare(
      `UPDATE scout_setups SET version = version + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'published' AND version = ? AND result_message_id IS NOT NULL`,
    ).run(setupId, expectedVersion);
    if (claimed.changes !== 1) return false;
    const first = rows.find((row) => row.id === firstSlotId)!;
    const second = rows.find((row) => row.id === secondSlotId)!;
    const update = db.prepare(
      `UPDATE scout_roster_slots SET user_id = ?, staff_assigned = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    );
    update.run(second.user_id, second.staff_assigned, first.id);
    update.run(first.user_id, first.staff_assigned, second.id);
    return true;
  })();
}

export function rollbackPublishedScoutRosterSwap(
  db: Database.Database,
  setupId: number,
  updatedVersion: number,
  firstSlotId: number,
  secondSlotId: number,
): boolean {
  return db.transaction(() => {
    const rows = db.prepare(
      'SELECT * FROM scout_roster_slots WHERE setup_id = ? AND id IN (?, ?)',
    ).all(setupId, firstSlotId, secondSlotId) as ScoutRosterSlotRow[];
    if (rows.length !== 2 || firstSlotId === secondSlotId) return false;
    const restored = db.prepare(
      `UPDATE scout_setups SET version = version - 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'published' AND version = ? AND result_message_id IS NOT NULL`,
    ).run(setupId, updatedVersion);
    if (restored.changes !== 1) return false;
    const first = rows.find((row) => row.id === firstSlotId)!;
    const second = rows.find((row) => row.id === secondSlotId)!;
    const update = db.prepare(
      `UPDATE scout_roster_slots SET user_id = ?, staff_assigned = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    );
    update.run(second.user_id, second.staff_assigned, first.id);
    update.run(first.user_id, first.staff_assigned, second.id);
    return true;
  })();
}

export function replaceScoutRosterIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
  slots: readonly ScoutRosterSlot[],
): boolean {
  return db.transaction(() => {
    const setup = db.prepare('SELECT game_count FROM scout_setups WHERE id = ?').get(setupId) as { game_count: number };
    assertCompleteScoutRoster(slots, setup.game_count);
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
