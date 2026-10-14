import type Database from 'better-sqlite3';

export type InventoryMember = { discordId: string; displayName: string; bot: boolean; roleIds: readonly string[] };
export type InventoryRole = { id: string; name: string };

export function observeInventoryMember(db: Database.Database, guildId: string, member: InventoryMember, at: string) {
  db.prepare(`INSERT INTO guild_inventory_members VALUES(?,?,?,?,1,?,?)
    ON CONFLICT(guild_id,discord_id) DO UPDATE SET display_name=excluded.display_name,bot=excluded.bot,
      present=1,role_ids_json=excluded.role_ids_json,observed_at=excluded.observed_at`)
    .run(guildId, member.discordId, member.displayName, Number(member.bot), JSON.stringify([...new Set(member.roleIds)].sort()), at);
}
export function observeInventoryDeparture(db: Database.Database, guildId: string,
  member: { discordId: string; displayName?: string; bot?: boolean }, at: string) {
  db.prepare(`INSERT INTO guild_inventory_members VALUES(?,?,?,?,0,'[]',?)
    ON CONFLICT(guild_id,discord_id) DO UPDATE SET present=0,role_ids_json='[]',observed_at=excluded.observed_at,
      display_name=COALESCE(?,guild_inventory_members.display_name),bot=COALESCE(?,guild_inventory_members.bot)`)
    .run(guildId, member.discordId, member.displayName ?? member.discordId, Number(member.bot ?? false), at,
      member.displayName ?? null, member.bot === undefined ? null : Number(member.bot));
}
export function observeInventoryRole(db: Database.Database, guildId: string, role: InventoryRole, at: string) {
  db.prepare(`INSERT INTO guild_inventory_roles VALUES(?,?,?,1,?)
    ON CONFLICT(guild_id,role_id) DO UPDATE SET name=excluded.name,present=1,observed_at=excluded.observed_at`)
    .run(guildId, role.id, role.name, at);
}
export function observeInventoryRoleDeletion(db: Database.Database, guildId: string, roleId: string, at: string) {
  db.transaction(() => {
    db.prepare('UPDATE guild_inventory_roles SET present=0,observed_at=? WHERE guild_id=? AND role_id=?').run(at, guildId, roleId);
    db.prepare(`UPDATE guild_inventory_members SET role_ids_json=(SELECT json_group_array(value)
      FROM json_each(role_ids_json) WHERE value<>?),observed_at=? WHERE guild_id=?
      AND EXISTS(SELECT 1 FROM json_each(role_ids_json) WHERE value=?)`).run(roleId, at, guildId, roleId);
  })();
}
/** Only call with the reader's validated complete snapshot. Missing members are
 * observations of departure, never executable roster or role changes. */
export function observeFullGuildInventory(db: Database.Database, guildId: string,
  members: readonly InventoryMember[], roles: readonly InventoryRole[], at: string) {
  db.transaction(() => {
    db.prepare("UPDATE guild_inventory_members SET present=0,role_ids_json='[]',observed_at=? WHERE guild_id=?").run(at, guildId);
    db.prepare('UPDATE guild_inventory_roles SET present=0,observed_at=? WHERE guild_id=?').run(at, guildId);
    for (const member of members) observeInventoryMember(db, guildId, member, at);
    for (const role of roles) observeInventoryRole(db, guildId, role, at);
    db.prepare(`INSERT INTO guild_inventory_sync VALUES(?,?,?) ON CONFLICT(guild_id)
      DO UPDATE SET last_full_at=excluded.last_full_at,member_count=excluded.member_count`).run(guildId, at, members.length);
  })();
}
export function getGuildRoleInventory(db: Database.Database, guildId: string) {
  const members = db.prepare(`SELECT discord_id,display_name,bot,present,role_ids_json,observed_at
    FROM guild_inventory_members WHERE guild_id=? ORDER BY discord_id`).all(guildId) as Array<{
      discord_id: string; display_name: string; bot: number; present: number; role_ids_json: string; observed_at: string;
    }>;
  const roles = db.prepare('SELECT role_id,name,present,observed_at FROM guild_inventory_roles WHERE guild_id=? ORDER BY role_id')
    .all(guildId) as Array<{ role_id: string; name: string; present: number; observed_at: string }>;
  const sync = db.prepare('SELECT last_full_at,member_count FROM guild_inventory_sync WHERE guild_id=?')
    .get(guildId) as { last_full_at: string; member_count: number } | undefined;
  return { members: members.map(row => ({ discordId: row.discord_id, displayName: row.display_name, bot: Boolean(row.bot),
    present: Boolean(row.present), roleIds: JSON.parse(row.role_ids_json) as string[], observedAt: row.observed_at })),
    roles: roles.map(row => ({ roleId: row.role_id, name: row.name, present: Boolean(row.present), observedAt: row.observed_at })),
    lastFullAt: sync?.last_full_at ?? null, lastFullMemberCount: sync?.member_count ?? null };
}
