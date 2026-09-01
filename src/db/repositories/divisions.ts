import type Database from 'better-sqlite3';
import type { DivisionRecord, DivisionStatus } from '../types.js';

type DivisionRow = {
  id: number;
  guild_id: string;
  division_key: string;
  display_name: string;
  season_id: number | null;
  role_id: string | null;
  manager_role_id: string | null;
  captain_role_id: string | null;
  category_id: string | null;
  status: DivisionStatus;
  created_at: string;
  updated_at: string;
};

function toDivisionRecord(row: DivisionRow): DivisionRecord {
  return {
    id: row.id,
    guildId: row.guild_id,
    divisionKey: row.division_key,
    displayName: row.display_name,
    seasonId: row.season_id,
    roleId: row.role_id,
    managerRoleId: row.manager_role_id,
    captainRoleId: row.captain_role_id,
    categoryId: row.category_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type UpsertDivisionInput = {
  guildId: string;
  divisionKey: string;
  displayName: string;
  seasonId?: number | null;
  roleId?: string | null;
  managerRoleId?: string | null;
  captainRoleId?: string | null;
  categoryId?: string | null;
};

// Insert-or-update on (guildId, divisionKey) -- the authored, stable key,
// never the display name (#31 Defect 1/Defect 2). displayName is updated on
// every conflict since it's presentational and expected to track config.
//
// status is always reset to 'active' here, on every provisioning run --
// this is not a side effect layered on top of provisioning, it's provisioning
// telling the truth about what it just did: ensureCategory/ensureChannel
// unconditionally restore each resource's active-state permission overwrites
// regardless of the division's previous archived status, so a division that
// was archived and then re-provisioned via /division add is, in reality,
// visible again. Leaving status at 'archived' after that would let
// /division delete's "must be archived first" safety gate pass against a
// division that Discord-side is no longer archived at all.
export function upsertDivision(db: Database.Database, input: UpsertDivisionInput): DivisionRecord {
  const row = db
    .prepare(
      `
      INSERT INTO divisions (guild_id, division_key, display_name, season_id, role_id, manager_role_id, captain_role_id, category_id, status)
      VALUES (@guildId, @divisionKey, @displayName, @seasonId, @roleId, @managerRoleId, @captainRoleId, @categoryId, 'active')
      ON CONFLICT (guild_id, division_key) DO UPDATE SET
        display_name = excluded.display_name,
        season_id = excluded.season_id,
        role_id = excluded.role_id,
        manager_role_id = excluded.manager_role_id,
        captain_role_id = excluded.captain_role_id,
        category_id = excluded.category_id,
        status = 'active',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      RETURNING *;
      `,
    )
    .get({
      guildId: input.guildId,
      divisionKey: input.divisionKey,
      displayName: input.displayName,
      seasonId: input.seasonId ?? null,
      roleId: input.roleId ?? null,
      managerRoleId: input.managerRoleId ?? null,
      captainRoleId: input.captainRoleId ?? null,
      categoryId: input.categoryId ?? null,
    }) as DivisionRow;

  return toDivisionRecord(row);
}

export function getDivisionByKey(db: Database.Database, guildId: string, divisionKey: string): DivisionRecord | undefined {
  const row = db
    .prepare('SELECT * FROM divisions WHERE guild_id = ? AND division_key = ?')
    .get(guildId, divisionKey) as DivisionRow | undefined;

  return row ? toDivisionRecord(row) : undefined;
}

export function listDivisions(db: Database.Database, guildId: string, status?: DivisionStatus): DivisionRecord[] {
  const rows = status
    ? (db.prepare('SELECT * FROM divisions WHERE guild_id = ? AND status = ?').all(guildId, status) as DivisionRow[])
    : (db.prepare('SELECT * FROM divisions WHERE guild_id = ?').all(guildId) as DivisionRow[]);

  return rows.map(toDivisionRecord);
}

export function setDivisionStatus(db: Database.Database, guildId: string, divisionKey: string, status: DivisionStatus): void {
  db.prepare(
    "UPDATE divisions SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE guild_id = ? AND division_key = ?",
  ).run(status, guildId, divisionKey);
}
