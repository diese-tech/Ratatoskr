import type Database from 'better-sqlite3';
import type { DivisionRecord, DivisionStatus } from '../types.js';

type DivisionRow = {
  id: number;
  guild_id: string;
  division_name: string;
  season_id: number | null;
  role_id: string | null;
  captain_access_role_id: string | null;
  category_id: string | null;
  status: DivisionStatus;
  created_at: string;
  updated_at: string;
};

function toDivisionRecord(row: DivisionRow): DivisionRecord {
  return {
    id: row.id,
    guildId: row.guild_id,
    divisionName: row.division_name,
    seasonId: row.season_id,
    roleId: row.role_id,
    captainAccessRoleId: row.captain_access_role_id,
    categoryId: row.category_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type UpsertDivisionInput = {
  guildId: string;
  divisionName: string;
  seasonId?: number | null;
  roleId?: string | null;
  captainAccessRoleId?: string | null;
  categoryId?: string | null;
};

// Insert-or-update on (guildId, divisionName), matching how the existing
// division provisioner already treats division name as the reconciliation
// key. Safe to call every time a division is provisioned/reconciled; it
// never creates a duplicate row for the same division.
export function upsertDivision(db: Database.Database, input: UpsertDivisionInput): DivisionRecord {
  const row = db
    .prepare(
      `
      INSERT INTO divisions (guild_id, division_name, season_id, role_id, captain_access_role_id, category_id)
      VALUES (@guildId, @divisionName, @seasonId, @roleId, @captainAccessRoleId, @categoryId)
      ON CONFLICT (guild_id, division_name) DO UPDATE SET
        season_id = excluded.season_id,
        role_id = excluded.role_id,
        captain_access_role_id = excluded.captain_access_role_id,
        category_id = excluded.category_id,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      RETURNING *;
      `,
    )
    .get({
      guildId: input.guildId,
      divisionName: input.divisionName,
      seasonId: input.seasonId ?? null,
      roleId: input.roleId ?? null,
      captainAccessRoleId: input.captainAccessRoleId ?? null,
      categoryId: input.categoryId ?? null,
    }) as DivisionRow;

  return toDivisionRecord(row);
}

export function getDivisionByName(db: Database.Database, guildId: string, divisionName: string): DivisionRecord | undefined {
  const row = db
    .prepare('SELECT * FROM divisions WHERE guild_id = ? AND division_name = ?')
    .get(guildId, divisionName) as DivisionRow | undefined;

  return row ? toDivisionRecord(row) : undefined;
}

export function listDivisions(db: Database.Database, guildId: string, status?: DivisionStatus): DivisionRecord[] {
  const rows = status
    ? (db.prepare('SELECT * FROM divisions WHERE guild_id = ? AND status = ?').all(guildId, status) as DivisionRow[])
    : (db.prepare('SELECT * FROM divisions WHERE guild_id = ?').all(guildId) as DivisionRow[]);

  return rows.map(toDivisionRecord);
}

export function setDivisionStatus(db: Database.Database, guildId: string, divisionName: string, status: DivisionStatus): void {
  db.prepare(
    "UPDATE divisions SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE guild_id = ? AND division_name = ?",
  ).run(status, guildId, divisionName);
}
