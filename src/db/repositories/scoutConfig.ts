import type Database from 'better-sqlite3';
import { SCOUT_ROLES, SCOUT_ROLE_LABELS, type ScoutRole } from '../../domain/scoutRoles.js';
import type { ScoutConfig } from '../types.js';

type ScoutConfigRow = {
  guild_id: string;
  authorized_role_ids: string;
  operations_category_id: string | null;
  operations_channel_id: string | null;
  solo_emoji_id: string | null;
  jungle_emoji_id: string | null;
  mid_emoji_id: string | null;
  support_emoji_id: string | null;
  carry_emoji_id: string | null;
  fill_emoji_id: string | null;
  timezone: string;
  created_at: string;
  updated_at: string;
};

function parseAuthorizedRoleIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function toScoutConfig(row: ScoutConfigRow): ScoutConfig {
  return {
    guildId: row.guild_id,
    authorizedRoleIds: parseAuthorizedRoleIds(row.authorized_role_ids),
    operationsCategoryId: row.operations_category_id,
    operationsChannelId: row.operations_channel_id,
    emojiByRole: {
      solo: row.solo_emoji_id,
      jungle: row.jungle_emoji_id,
      mid: row.mid_emoji_id,
      support: row.support_emoji_id,
      carry: row.carry_emoji_id,
      fill: row.fill_emoji_id,
    },
    timezone: row.timezone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getScoutConfig(db: Database.Database, guildId: string): ScoutConfig | undefined {
  const row = db.prepare('SELECT * FROM scout_config WHERE guild_id = ?').get(guildId) as ScoutConfigRow | undefined;
  return row ? toScoutConfig(row) : undefined;
}

export function ensureScoutConfig(db: Database.Database, guildId: string): ScoutConfig {
  db.prepare('INSERT OR IGNORE INTO scout_config (guild_id) VALUES (?)').run(guildId);
  return getScoutConfig(db, guildId)!;
}

export function setScoutAuthorizedRoleIds(
  db: Database.Database,
  guildId: string,
  authorizedRoleIds: readonly string[],
): ScoutConfig {
  ensureScoutConfig(db, guildId);
  db.prepare(
    `UPDATE scout_config
     SET authorized_role_ids = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE guild_id = ?`,
  ).run(JSON.stringify([...authorizedRoleIds]), guildId);
  return getScoutConfig(db, guildId)!;
}

export function setScoutEmojiByRole(
  db: Database.Database,
  guildId: string,
  emojiByRole: Record<ScoutRole, string> & { fill?: string | null },
): ScoutConfig {
  ensureScoutConfig(db, guildId);
  db.prepare(
    `UPDATE scout_config
     SET solo_emoji_id = ?, jungle_emoji_id = ?, mid_emoji_id = ?, support_emoji_id = ?, carry_emoji_id = ?, fill_emoji_id = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE guild_id = ?`,
  ).run(
    emojiByRole.solo,
    emojiByRole.jungle,
    emojiByRole.mid,
    emojiByRole.support,
    emojiByRole.carry,
    emojiByRole.fill ?? null,
    guildId,
  );
  return getScoutConfig(db, guildId)!;
}

export function setScoutTimezone(db: Database.Database, guildId: string, timezone: string): ScoutConfig {
  ensureScoutConfig(db, guildId);
  db.prepare(
    `UPDATE scout_config
     SET timezone = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE guild_id = ?`,
  ).run(timezone, guildId);
  return getScoutConfig(db, guildId)!;
}

export function setScoutOperationsChannel(
  db: Database.Database,
  guildId: string,
  operationsCategoryId: string,
  operationsChannelId: string,
): ScoutConfig {
  db.transaction(() => {
    ensureScoutConfig(db, guildId);
    db.prepare(
      `UPDATE scout_config
       SET operations_category_id = ?, operations_channel_id = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE guild_id = ?`,
    ).run(operationsCategoryId, operationsChannelId, guildId);
    db.prepare(
      `UPDATE scout_setups
       SET operations_channel_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE guild_id = ? AND status IN ('posting', 'open', 'roster_ready')`,
    ).run(operationsChannelId, guildId);
  })();
  return getScoutConfig(db, guildId)!;
}

export function missingScoutConfigFields(config: ScoutConfig): string[] {
  return SCOUT_ROLES.filter((role) => !config.emojiByRole[role]).map((role) => `${SCOUT_ROLE_LABELS[role]} emoji`);
}
