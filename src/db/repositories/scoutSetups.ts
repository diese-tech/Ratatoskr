import type Database from 'better-sqlite3';
import { SCOUT_ROLE_LABELS, type ScoutRole, type ScoutSignupRole } from '../../domain/index.js';
import type { ScoutRosterSlot, ScoutTeam } from '../../domain/scoutRoster.js';
import type { ScoutRosterSlotRecord, ScoutSetup, ScoutSetupStatus, ScoutSignup } from '../types.js';
import { appendScoutEvent } from './scoutEvents.js';
import { initializeScoutGameHosts } from './scoutGameHosts.js';
import { scheduleScoutNotification, skipScheduledScoutNotification } from './scoutNotifications.js';

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
  return db.transaction(() => {
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
    db.prepare('INSERT INTO scout_coordination (setup_id, organizer_user_id) VALUES (?, ?)')
      .run(row.id, input.createdBy);
    return toScoutSetup(row);
  })();
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
  divisionId?: number,
): ScoutSetup[] {
  const rows = db
    .prepare(
      `SELECT * FROM scout_setups
       WHERE guild_id = ? AND (? IS NULL OR division_id = ?) AND status IN ('open', 'roster_ready')
       ORDER BY start_at, id`,
    )
    .all(guildId, divisionId ?? null, divisionId ?? null) as ScoutSetupRow[];
  return rows.map(toScoutSetup);
}

export function listDivisionScoutLifecycleBlockers(db: Database.Database, guildId: string, divisionId: number): ScoutSetup[] {
  const rows = db.prepare(`SELECT * FROM scout_setups
    WHERE guild_id = ? AND division_id = ? AND (
      status IN ('posting', 'open', 'roster_ready') OR
      (status = 'published' AND (NOT EXISTS (SELECT 1 FROM scout_completions WHERE setup_id = scout_setups.id)
        OR result_message_id IS NULL OR signup_post_reconciled = 0
        OR EXISTS (SELECT 1 FROM scout_roster_updates WHERE setup_id = scout_setups.id)
        OR EXISTS (SELECT 1 FROM scout_completions WHERE setup_id = scout_setups.id AND posts_reconciled = 0)))
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
       AND NOT EXISTS (SELECT 1 FROM scout_completions WHERE setup_id = scout_setups.id)
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
  off_role: number;
  assigned_by_user_id: string | null;
  replacement_needed: number;
  replacement_requested_at: string | null;
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
    offRole: row.off_role === 1,
    assignedByUserId: row.assigned_by_user_id,
    replacementNeeded: row.replacement_needed === 1,
    replacementRequestedAt: row.replacement_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export type ReconcileScoutWorkingRosterInput = {
  setupId: number;
  expectedVersion: number;
  slots: readonly ScoutRosterSlot[];
  source: 'signup' | 'startup' | 'membership' | 'refresh';
  actorUserId?: string | null;
};

export type ReconcileScoutWorkingRosterOutcome = 'updated' | 'unchanged' | 'stale';

export function reconcileScoutWorkingRoster(
  db: Database.Database,
  input: ReconcileScoutWorkingRosterInput,
): ReconcileScoutWorkingRosterOutcome {
  return db.transaction((): ReconcileScoutWorkingRosterOutcome => {
    const setup = db.prepare('SELECT status, version, game_count FROM scout_setups WHERE id = ?')
      .get(input.setupId) as { status: ScoutSetupStatus; version: number; game_count: 1 | 2 } | undefined;
    if (!setup || !['open', 'roster_ready'].includes(setup.status) || setup.version !== input.expectedVersion) {
      return 'stale';
    }

    const current = db.prepare('SELECT * FROM scout_roster_slots WHERE setup_id = ? ORDER BY id')
      .all(input.setupId) as ScoutRosterSlotRow[];
    const manual = current.filter((slot) => slot.staff_assigned === 1);
    const manualLocations = new Set(manual.map((slot) => `${slot.game_number}:${slot.team}:${slot.role}`));
    const manualUsers = new Set(manual.map((slot) => slot.user_id));
    const locations = new Set<string>();
    const users = new Set<string>();
    const desiredAutomatic: ScoutRosterSlot[] = [];

    for (const raw of input.slots) {
      const slot = { ...raw, gameNumber: raw.gameNumber ?? 1 };
      if (slot.gameNumber < 1 || slot.gameNumber > setup.game_count) {
        throw new Error(`Working roster slot has invalid game number ${slot.gameNumber}.`);
      }
      const location = `${slot.gameNumber}:${slot.team}:${slot.role}`;
      if (locations.has(location) || users.has(slot.userId)) {
        throw new Error('Working roster must contain unique locations and users.');
      }
      locations.add(location);
      users.add(slot.userId);
      if (manualLocations.has(location) || manualUsers.has(slot.userId)) continue;
      desiredAutomatic.push(slot);
    }

    for (const slot of manual) {
      const location = `${slot.game_number}:${slot.team}:${slot.role}`;
      if (!locations.has(location) || !users.has(slot.user_id)) {
        throw new Error('Working roster reconciliation must include every fixed manual assignment.');
      }
    }

    const currentAutomatic = current.filter((slot) => slot.staff_assigned === 0);
    const fingerprint = (slots: readonly { gameNumber?: number; game_number?: number; team: ScoutTeam; role: ScoutRole; userId?: string; user_id?: string }[]) =>
      slots.map((slot) => `${slot.gameNumber ?? slot.game_number ?? 1}:${slot.team}:${slot.role}:${slot.userId ?? slot.user_id}`)
        .sort().join('|');
    const seated = manual.length + desiredAutomatic.length;
    const desiredStatus: ScoutSetupStatus = seated === setup.game_count * 10 ? 'roster_ready' : 'open';
    if (fingerprint(currentAutomatic) === fingerprint(desiredAutomatic) && setup.status === desiredStatus) {
      return 'unchanged';
    }

    const claimed = db.prepare(
      `UPDATE scout_setups SET status = ?, version = version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND version = ? AND status IN ('open', 'roster_ready')`,
    ).run(desiredStatus, input.setupId, input.expectedVersion);
    if (claimed.changes !== 1) return 'stale';

    db.prepare('DELETE FROM scout_roster_slots WHERE setup_id = ? AND staff_assigned = 0').run(input.setupId);
    const insert = db.prepare(
      `INSERT INTO scout_roster_slots (setup_id, game_number, team, role, user_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const slot of desiredAutomatic) {
      insert.run(input.setupId, slot.gameNumber ?? 1, slot.team, slot.role, slot.userId);
    }
    appendScoutEvent(db, {
      setupId: input.setupId,
      setupVersion: input.expectedVersion + 1,
      eventType: 'working_roster_reconciled',
      actorUserId: input.actorUserId,
      payload: { source: input.source, seated, status: desiredStatus },
    });
    return 'updated';
  })();
}

export type SeatScoutRosterSlotInput = {
  setupId: number;
  expectedVersion: number;
  gameNumber: 1 | 2;
  team: ScoutTeam;
  role: ScoutRole;
  userId: string;
  actorUserId: string;
  confirmOffRole: boolean;
};

export type SeatScoutRosterSlotOutcome =
  | 'updated'
  | 'stale'
  | 'duplicate'
  | 'ineligible'
  | 'occupied'
  | 'off_role_confirmation';

export function seatScoutRosterSlotIfVersion(
  db: Database.Database,
  input: SeatScoutRosterSlotInput,
): SeatScoutRosterSlotOutcome {
  return db.transaction((): SeatScoutRosterSlotOutcome => {
    const setup = db.prepare('SELECT status, version, game_count FROM scout_setups WHERE id = ?')
      .get(input.setupId) as { status: ScoutSetupStatus; version: number; game_count: 1 | 2 } | undefined;
    if (!setup || !['open', 'roster_ready'].includes(setup.status) ||
        setup.version !== input.expectedVersion || input.gameNumber > setup.game_count) return 'stale';

    const signups = db.prepare('SELECT role FROM scout_signups WHERE setup_id = ? AND user_id = ?')
      .all(input.setupId, input.userId) as { role: ScoutSignupRole }[];
    if (signups.length === 0) return 'ineligible';
    const offRole = !signups.some((signup) => signup.role === input.role || signup.role === 'fill');
    if (offRole && !input.confirmOffRole) return 'off_role_confirmation';
    if (db.prepare('SELECT 1 FROM scout_roster_slots WHERE setup_id = ? AND user_id = ?')
      .get(input.setupId, input.userId)) return 'duplicate';
    if (db.prepare(
      'SELECT 1 FROM scout_roster_slots WHERE setup_id = ? AND game_number = ? AND team = ? AND role = ?',
    ).get(input.setupId, input.gameNumber, input.team, input.role)) return 'occupied';

    const currentCount = (db.prepare('SELECT COUNT(*) AS count FROM scout_roster_slots WHERE setup_id = ?')
      .get(input.setupId) as { count: number }).count;
    const desiredStatus: ScoutSetupStatus = currentCount + 1 === setup.game_count * 10 ? 'roster_ready' : 'open';
    const claimed = db.prepare(
      `UPDATE scout_setups SET status = ?, version = version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND version = ? AND status IN ('open', 'roster_ready')`,
    ).run(desiredStatus, input.setupId, input.expectedVersion);
    if (claimed.changes !== 1) return 'stale';

    db.prepare(
      `INSERT INTO scout_roster_slots (
         setup_id, game_number, team, role, user_id, staff_assigned, off_role, assigned_by_user_id
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      input.setupId, input.gameNumber, input.team, input.role, input.userId,
      offRole ? 1 : 0, input.actorUserId,
    );
    appendScoutEvent(db, {
      setupId: input.setupId,
      setupVersion: input.expectedVersion + 1,
      eventType: 'manual_seat',
      actorUserId: input.actorUserId,
      payload: {
        gameNumber: input.gameNumber, team: input.team, role: input.role,
        userId: input.userId, offRole,
      },
    });
    return 'updated';
  })();
}

export function swapScoutRosterSlotsIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
  firstSlotId: number,
  secondSlotId: number,
  staffOverride: boolean,
  actorUserId?: string,
): boolean {
  return db.transaction(() => {
    const rows = db
      .prepare('SELECT * FROM scout_roster_slots WHERE setup_id = ? AND id IN (?, ?)')
      .all(setupId, firstSlotId, secondSlotId) as ScoutRosterSlotRow[];
    if (rows.length !== 2 || firstSlotId === secondSlotId) return false;
    const claimed = db
      .prepare(
        `UPDATE scout_setups SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status IN ('open', 'roster_ready') AND version = ?`,
      )
      .run(setupId, expectedVersion);
    if (claimed.changes !== 1) return false;
    const first = rows.find((row) => row.id === firstSlotId)!;
    const second = rows.find((row) => row.id === secondSlotId)!;
    const update = db.prepare(
      `UPDATE scout_roster_slots
       SET user_id = ?, staff_assigned = ?, off_role = ?, assigned_by_user_id = ?,
           replacement_needed = ?, replacement_requested_at = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    );
    db.prepare('UPDATE scout_roster_slots SET user_id = ? WHERE id = ?')
      .run(`__scout_swap_${setupId}_${first.id}_${second.id}`, first.id);
    update.run(
      first.user_id, staffOverride || first.staff_assigned === 1 ? 1 : 0,
      first.off_role, staffOverride ? actorUserId ?? first.assigned_by_user_id : first.assigned_by_user_id,
      first.replacement_needed, first.replacement_requested_at, second.id,
    );
    update.run(
      second.user_id, staffOverride || second.staff_assigned === 1 ? 1 : 0,
      second.off_role, staffOverride ? actorUserId ?? second.assigned_by_user_id : second.assigned_by_user_id,
      second.replacement_needed, second.replacement_requested_at, first.id,
    );
    appendScoutEvent(db, {
      setupId,
      setupVersion: expectedVersion + 1,
      eventType: 'roster_slots_swapped',
      actorUserId,
      payload: { firstSlotId, secondSlotId, published: false },
    });
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
  actorUserId?: string,
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
         WHERE id = ? AND status IN ('open', 'roster_ready') AND version = ?`,
      )
      .run(setupId, expectedVersion);
    if (claimed.changes !== 1) return 'stale';
    const signedForRole = Boolean(db.prepare(
      `SELECT 1 FROM scout_signups WHERE setup_id = ? AND user_id = ? AND role IN (?, 'fill') LIMIT 1`,
    ).get(setupId, userId, (db.prepare('SELECT role FROM scout_roster_slots WHERE id = ?').get(slotId) as { role: ScoutRole }).role));
    db.prepare(
      `UPDATE scout_roster_slots SET user_id = ?, staff_assigned = ?, off_role = ?,
       assigned_by_user_id = ?, replacement_needed = 0, replacement_requested_at = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(userId, staffAssigned ? 1 : 0, staffAssigned && !signedForRole ? 1 : 0,
      staffAssigned ? actorUserId ?? null : null, slotId);
    appendScoutEvent(db, {
      setupId,
      setupVersion: expectedVersion + 1,
      eventType: 'roster_slot_replaced',
      actorUserId,
      payload: { slotId, userId, published: false },
    });
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
        `UPDATE scout_setups SET status = 'published', results_channel_id = signup_channel_id,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
    const slot = db.prepare('SELECT * FROM scout_roster_slots WHERE setup_id = ? AND id = ?').get(setupId, slotId) as ScoutRosterSlotRow | undefined;
    if (!slot) return 'stale';
    if (db.prepare('SELECT 1 FROM scout_roster_slots WHERE setup_id = ? AND user_id = ?').get(setupId, userId)) {
      return 'duplicate';
    }
    const claimed = db
      .prepare(
        `UPDATE scout_setups SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'published' AND version = ? AND result_message_id IS NOT NULL AND signup_post_reconciled = 1
         AND NOT EXISTS (SELECT 1 FROM scout_completions WHERE setup_id = scout_setups.id)
         AND NOT EXISTS (SELECT 1 FROM scout_roster_updates WHERE setup_id = scout_setups.id)`,
      )
      .run(setupId, expectedVersion);
    if (claimed.changes !== 1) return 'stale';
    db.prepare(
      `UPDATE scout_roster_slots SET user_id = ?, staff_assigned = 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(userId, slotId);
    db.prepare('INSERT INTO scout_roster_updates (setup_id, version, notice) VALUES (?, ?, ?)')
      .run(setupId, expectedVersion + 1, `Roster update: <@${slot.user_id}> was replaced by <@${userId}> at ${rosterSlotLocation(slot)}.`);
    return 'updated';
  })();
}

export function swapPublishedScoutRosterSlotsIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
  firstSlotId: number,
  secondSlotId: number,
  actorUserId?: string,
): boolean {
  return db.transaction(() => {
    const rows = db.prepare(
      'SELECT * FROM scout_roster_slots WHERE setup_id = ? AND id IN (?, ?)',
    ).all(setupId, firstSlotId, secondSlotId) as ScoutRosterSlotRow[];
    if (rows.length !== 2 || firstSlotId === secondSlotId) return false;
    const claimed = db.prepare(
      `UPDATE scout_setups SET version = version + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'published' AND version = ? AND result_message_id IS NOT NULL AND signup_post_reconciled = 1
         AND NOT EXISTS (SELECT 1 FROM scout_completions WHERE setup_id = scout_setups.id)
         AND NOT EXISTS (SELECT 1 FROM scout_roster_updates WHERE setup_id = scout_setups.id)`,
    ).run(setupId, expectedVersion);
    if (claimed.changes !== 1) return false;
    const first = rows.find((row) => row.id === firstSlotId)!;
    const second = rows.find((row) => row.id === secondSlotId)!;
    const update = db.prepare(
      `UPDATE scout_roster_slots SET user_id = ?, staff_assigned = ?, off_role = ?,
       assigned_by_user_id = ?, replacement_needed = ?, replacement_requested_at = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    );
    db.prepare('UPDATE scout_roster_slots SET user_id = ? WHERE id = ?')
      .run(`__scout_swap_${setupId}_${first.id}_${second.id}`, first.id);
    update.run(first.user_id, first.staff_assigned, first.off_role, first.assigned_by_user_id,
      first.replacement_needed, first.replacement_requested_at, second.id);
    update.run(second.user_id, second.staff_assigned, second.off_role, second.assigned_by_user_id,
      second.replacement_needed, second.replacement_requested_at, first.id);
    db.prepare('INSERT INTO scout_roster_updates (setup_id, version, notice) VALUES (?, ?, ?)')
      .run(setupId, expectedVersion + 1, `Roster update: <@${first.user_id}> and <@${second.user_id}> swapped between ${rosterSlotLocation(first)} and ${rosterSlotLocation(second)}.`);
    appendScoutEvent(db, {
      setupId,
      setupVersion: expectedVersion + 1,
      eventType: 'roster_slots_swapped',
      actorUserId,
      payload: { firstSlotId, secondSlotId, published: true },
    });
    return true;
  })();
}

export type MarkScoutPlayerUnavailableInput = {
  setupId: number;
  expectedVersion: number;
  userId: string;
  now: number;
  random?: () => number;
};

export type MarkScoutPlayerUnavailableOutcome =
  | { status: 'updated' | 'unchanged'; slot: ScoutRosterSlotRecord; newHostUserId?: string }
  | { status: 'stale' | 'not_rostered' };

export function markScoutPlayerUnavailableIfVersion(
  db: Database.Database,
  input: MarkScoutPlayerUnavailableInput,
): MarkScoutPlayerUnavailableOutcome {
  return db.transaction((): MarkScoutPlayerUnavailableOutcome => {
    const setup = getScoutSetupById(db, input.setupId);
    if (!setup || setup.status !== 'published' || !setup.operationsChannelId ||
        !setup.resultMessageId || !setup.signupPostReconciled ||
        db.prepare('SELECT 1 FROM scout_completions WHERE setup_id = ?').get(input.setupId) ||
        db.prepare('SELECT 1 FROM scout_roster_updates WHERE setup_id = ?').get(input.setupId)) {
      return { status: 'stale' };
    }
    const slot = listScoutRosterSlots(db, input.setupId).find((candidate) => candidate.userId === input.userId);
    if (!slot) return { status: 'not_rostered' };
    if (slot.replacementNeeded) return { status: 'unchanged', slot };
    if (setup.version !== input.expectedVersion) return { status: 'stale' };
    const claimed = db.prepare(
      `UPDATE scout_setups SET version = version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND version = ? AND status = 'published'
         AND NOT EXISTS (SELECT 1 FROM scout_completions WHERE setup_id = scout_setups.id)
         AND NOT EXISTS (SELECT 1 FROM scout_roster_updates WHERE setup_id = scout_setups.id)`,
    ).run(input.setupId, input.expectedVersion);
    if (claimed.changes !== 1) return { status: 'stale' };
    const requestedAt = new Date(input.now * 1_000).toISOString();
    db.prepare(
      `UPDATE scout_roster_slots SET replacement_needed = 1, replacement_requested_at = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(requestedAt, slot.id);
    db.prepare("INSERT INTO scout_roster_updates (setup_id, version, notice) VALUES (?, ?, '')")
      .run(input.setupId, input.expectedVersion + 1);

    const currentHost = db.prepare(
      'SELECT lobby_host_user_id FROM scout_game_hosts WHERE setup_id = ? AND game_number = ?',
    ).get(input.setupId, slot.gameNumber) as { lobby_host_user_id: string } | undefined;
    let newHostUserId: string | undefined;
    if (currentHost?.lobby_host_user_id === input.userId) {
      const candidates = db.prepare(
        `SELECT user_id FROM scout_roster_slots
         WHERE setup_id = ? AND game_number = ? AND user_id <> ? AND replacement_needed = 0 ORDER BY id`,
      ).all(input.setupId, slot.gameNumber, input.userId) as { user_id: string }[];
      if (candidates.length) {
        const random = input.random ?? Math.random;
        newHostUserId = candidates[Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)))]!.user_id;
        db.prepare(
          `UPDATE scout_game_hosts SET lobby_host_user_id = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE setup_id = ? AND game_number = ?`,
        ).run(newHostUserId, input.setupId, slot.gameNumber);
      }
    }
    scheduleScoutNotification(db, {
      setupId: input.setupId,
      gameNumber: slot.gameNumber as 1 | 2,
      kind: 'availability_alert',
      dedupeKey: `availability:${input.setupId}:${slot.id}`,
      nonce: `a${input.setupId}-${slot.id}`,
      channelId: setup.operationsChannelId,
      dueAt: input.now,
    });
    appendScoutEvent(db, {
      setupId: input.setupId,
      setupVersion: input.expectedVersion + 1,
      eventType: 'replacement_requested',
      actorUserId: input.userId,
      payload: { slotId: slot.id, gameNumber: slot.gameNumber, team: slot.team, role: slot.role, newHostUserId },
    });
    if (newHostUserId) appendScoutEvent(db, {
      setupId: input.setupId,
      setupVersion: input.expectedVersion + 1,
      eventType: 'lobby_host_reassigned',
      actorUserId: input.userId,
      payload: { gameNumber: slot.gameNumber, previousUserId: input.userId, lobbyHostUserId: newHostUserId },
    });
    if (newHostUserId) scheduleScoutNotification(db, {
      setupId: input.setupId,
      gameNumber: slot.gameNumber as 1 | 2,
      kind: 'host_change',
      dedupeKey: `host-change:${input.setupId}:${input.expectedVersion + 1}`,
      nonce: `c${input.setupId}-${input.expectedVersion + 1}`,
      channelId: setup.resultsChannelId,
      dueAt: input.now,
    });
    return {
      status: 'updated',
      slot: { ...slot, replacementNeeded: true, replacementRequestedAt: requestedAt },
      ...(newHostUserId ? { newHostUserId } : {}),
    };
  })();
}

export type ReplacePublishedScoutRosterCandidateInput = {
  setupId: number;
  expectedVersion: number;
  slotId: number;
  userId: string;
  actorUserId: string;
  allowExplicitMember: boolean;
  now: number;
  random?: () => number;
};

export function replacePublishedScoutRosterCandidateIfVersion(
  db: Database.Database,
  input: ReplacePublishedScoutRosterCandidateInput,
): ReplaceScoutRosterSlotOutcome | 'ineligible' {
  return db.transaction((): ReplaceScoutRosterSlotOutcome | 'ineligible' => {
    const setup = getScoutSetupById(db, input.setupId);
    const slot = listScoutRosterSlots(db, input.setupId).find((candidate) => candidate.id === input.slotId);
    if (!setup || setup.status !== 'published' || setup.version !== input.expectedVersion ||
        !setup.resultMessageId || !setup.signupPostReconciled || !slot ||
        db.prepare('SELECT 1 FROM scout_completions WHERE setup_id = ?').get(input.setupId) ||
        db.prepare('SELECT 1 FROM scout_roster_updates WHERE setup_id = ?').get(input.setupId)) return 'stale';
    if (db.prepare('SELECT 1 FROM scout_roster_slots WHERE setup_id = ? AND user_id = ?')
      .get(input.setupId, input.userId)) return 'duplicate';
    const signups = db.prepare('SELECT role FROM scout_signups WHERE setup_id = ? AND user_id = ?')
      .all(input.setupId, input.userId) as { role: ScoutSignupRole }[];
    if (signups.length === 0 && !input.allowExplicitMember) return 'ineligible';
    const offRole = !signups.some((signup) => signup.role === slot.role || signup.role === 'fill');
    const claimed = db.prepare(
      `UPDATE scout_setups SET version = version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND version = ? AND status = 'published'
         AND NOT EXISTS (SELECT 1 FROM scout_completions WHERE setup_id = scout_setups.id)
         AND NOT EXISTS (SELECT 1 FROM scout_roster_updates WHERE setup_id = scout_setups.id)`,
    ).run(input.setupId, input.expectedVersion);
    if (claimed.changes !== 1) return 'stale';
    db.prepare(
      `UPDATE scout_roster_slots SET user_id = ?, staff_assigned = 1, off_role = ?,
       assigned_by_user_id = ?, replacement_needed = 0, replacement_requested_at = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(input.userId, offRole ? 1 : 0, input.actorUserId, input.slotId);

    const currentHost = db.prepare(
      'SELECT lobby_host_user_id FROM scout_game_hosts WHERE setup_id = ? AND game_number = ?',
    ).get(input.setupId, slot.gameNumber) as { lobby_host_user_id: string } | undefined;
    let newHostUserId: string | undefined;
    if (currentHost?.lobby_host_user_id === slot.userId) {
      const candidates = db.prepare(
        `SELECT user_id FROM scout_roster_slots
         WHERE setup_id = ? AND game_number = ? AND replacement_needed = 0 ORDER BY id`,
      ).all(input.setupId, slot.gameNumber) as { user_id: string }[];
      const random = input.random ?? Math.random;
      newHostUserId = candidates[Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)))]!.user_id;
      db.prepare(
        `UPDATE scout_game_hosts SET lobby_host_user_id = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE setup_id = ? AND game_number = ?`,
      ).run(newHostUserId, input.setupId, slot.gameNumber);
    }
    db.prepare("INSERT INTO scout_roster_updates (setup_id, version, notice) VALUES (?, ?, '')")
      .run(input.setupId, input.expectedVersion + 1);
    scheduleScoutNotification(db, {
      setupId: input.setupId,
      gameNumber: slot.gameNumber as 1 | 2,
      kind: 'replacement_notice',
      dedupeKey: `replacement:${input.setupId}:${input.expectedVersion + 1}`,
      nonce: `r${input.setupId}-${input.expectedVersion + 1}`,
      channelId: setup.resultsChannelId,
      dueAt: input.now,
    });
    if (newHostUserId) scheduleScoutNotification(db, {
      setupId: input.setupId,
      gameNumber: slot.gameNumber as 1 | 2,
      kind: 'host_change',
      dedupeKey: `host-change:${input.setupId}:${input.expectedVersion + 1}`,
      nonce: `c${input.setupId}-${input.expectedVersion + 1}`,
      channelId: setup.resultsChannelId,
      dueAt: input.now,
    });
    appendScoutEvent(db, {
      setupId: input.setupId,
      setupVersion: input.expectedVersion + 1,
      eventType: 'player_replaced',
      actorUserId: input.actorUserId,
      payload: {
        slotId: slot.id, gameNumber: slot.gameNumber, team: slot.team, role: slot.role,
        outgoingUserId: slot.userId, incomingUserId: input.userId, offRole, newHostUserId,
      },
    });
    return 'updated';
  })();
}

export type PrepareScoutPublicationInput = {
  setupId: number;
  expectedVersion: number;
  now: number;
  random?: () => number;
};

export type PrepareScoutPublicationOutcome =
  | { status: 'claimed'; hosts: { gameNumber: 1 | 2; userId: string }[] }
  | { status: 'stale' | 'withdrawals' };

export function prepareScoutPublication(
  db: Database.Database,
  input: PrepareScoutPublicationInput,
): PrepareScoutPublicationOutcome {
  return db.transaction((): PrepareScoutPublicationOutcome => {
    const claim = claimScoutPublish(db, input.setupId, input.expectedVersion);
    if (claim !== 'claimed') return { status: claim };
    const setup = db.prepare('SELECT game_count, start_at, signup_channel_id FROM scout_setups WHERE id = ?')
      .get(input.setupId) as { game_count: 1 | 2; start_at: number; signup_channel_id: string };
    const slots = listScoutRosterSlots(db, input.setupId);
    const random = input.random ?? Math.random;
    const hosts = Array.from({ length: setup.game_count }, (_, index) => {
      const gameNumber = (index + 1) as 1 | 2;
      const candidates = slots.filter((slot) => slot.gameNumber === gameNumber);
      if (candidates.length !== 10) throw new Error(`Game ${gameNumber} is not complete at publication.`);
      const selected = candidates[Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)))]!;
      return { gameNumber, userId: selected.userId };
    });
    if (!initializeScoutGameHosts(db, input.setupId, hosts)) {
      throw new Error('Initial Lobby Hosts could not be persisted.');
    }

    const cutoff = setup.start_at - 30 * 60;
    const scheduled = scheduleScoutNotification(db, {
      setupId: input.setupId,
      gameNumber: null,
      kind: 't30',
      dedupeKey: `t30:${input.setupId}`,
      nonce: `t30-${input.setupId}`,
      channelId: setup.signup_channel_id,
      dueAt: cutoff,
    });
    if (input.now >= cutoff && scheduled.notification.state === 'scheduled') {
      skipScheduledScoutNotification(db, scheduled.notification.id, 'late_publication');
    }
    appendScoutEvent(db, {
      setupId: input.setupId,
      setupVersion: input.expectedVersion,
      eventType: 'roster_published',
      payload: { hosts, t30: input.now < cutoff ? 'scheduled' : 'late_publication' },
    });
    for (const host of hosts) appendScoutEvent(db, {
      setupId: input.setupId,
      setupVersion: input.expectedVersion,
      eventType: 'lobby_host_assigned',
      payload: host,
    });
    return { status: 'claimed', hosts };
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

function rosterSlotLocation(slot: ScoutRosterSlotRow): string {
  return `Game ${slot.game_number} ${slot.team === 'team_one' ? 'Order' : 'Chaos'} ${SCOUT_ROLE_LABELS[slot.role]}`;
}

export type ScoutRosterUpdate = { setup_id: number; version: number; notice: string; message_reconciled: number; notice_attempted: number };
export function getScoutRosterUpdate(db: Database.Database, setupId: number): ScoutRosterUpdate | undefined {
  return db.prepare('SELECT * FROM scout_roster_updates WHERE setup_id = ?').get(setupId) as ScoutRosterUpdate | undefined;
}
export function listScoutRosterUpdates(db: Database.Database): ScoutRosterUpdate[] {
  return db.prepare('SELECT * FROM scout_roster_updates ORDER BY setup_id').all() as ScoutRosterUpdate[];
}
export function markScoutRosterUpdateEdited(db: Database.Database, setupId: number, version: number): void {
  db.prepare('UPDATE scout_roster_updates SET message_reconciled = 1 WHERE setup_id = ? AND version = ?').run(setupId, version);
}
export function markScoutRosterNoticeAttempted(db: Database.Database, setupId: number, version: number): void {
  db.prepare('UPDATE scout_roster_updates SET notice_attempted = 1 WHERE setup_id = ? AND version = ?').run(setupId, version);
}
export function completeScoutRosterUpdate(db: Database.Database, setupId: number, version: number): boolean {
  return db.prepare('DELETE FROM scout_roster_updates WHERE setup_id = ? AND version = ? AND message_reconciled = 1').run(setupId, version).changes === 1;
}
