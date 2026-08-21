import type Database from 'better-sqlite3';
import type { Season, SeasonStatus } from '../types.js';

type SeasonRow = {
  id: number;
  guild_id: string;
  season_number: number;
  display_name: string | null;
  category_name: string;
  discord_category_id: string | null;
  status: SeasonStatus;
  created_at: string;
  archived_at: string | null;
};

function toSeason(row: SeasonRow): Season {
  return {
    id: row.id,
    guildId: row.guild_id,
    seasonNumber: row.season_number,
    displayName: row.display_name,
    categoryName: row.category_name,
    discordCategoryId: row.discord_category_id,
    status: row.status,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

// The one place the "no custom name -> YSL Season <N>, custom name -> custom
// name entirely replaces it" naming contract is implemented, so future
// callers (the /season create command) never need to reimplement it.
export function computeSeasonCategoryName(seasonNumber: number, displayName: string | null | undefined): string {
  return displayName && displayName.trim().length > 0 ? displayName : `YSL Season ${seasonNumber}`;
}

export type CreateSeasonInput = {
  guildId: string;
  seasonNumber: number;
  displayName?: string | null;
};

// Season identity (seasonNumber) and its Discord-facing name are stored as
// separate columns and never reconstructed from one another -- category_name
// is computed once at creation from seasonNumber/displayName, not parsed
// back out of it later.
export function createSeason(db: Database.Database, input: CreateSeasonInput): Season {
  const displayName = input.displayName ?? null;
  const categoryName = computeSeasonCategoryName(input.seasonNumber, displayName);

  const row = db
    .prepare(
      `
      INSERT INTO seasons (guild_id, season_number, display_name, category_name)
      VALUES (@guildId, @seasonNumber, @displayName, @categoryName)
      RETURNING *;
      `,
    )
    .get({
      guildId: input.guildId,
      seasonNumber: input.seasonNumber,
      displayName,
      categoryName,
    }) as SeasonRow;

  return toSeason(row);
}

export function getSeasonByNumber(db: Database.Database, guildId: string, seasonNumber: number): Season | undefined {
  const row = db
    .prepare('SELECT * FROM seasons WHERE guild_id = ? AND season_number = ?')
    .get(guildId, seasonNumber) as SeasonRow | undefined;

  return row ? toSeason(row) : undefined;
}

export function getActiveSeason(db: Database.Database, guildId: string): Season | undefined {
  const row = db
    .prepare("SELECT * FROM seasons WHERE guild_id = ? AND status = 'active'")
    .get(guildId) as SeasonRow | undefined;

  return row ? toSeason(row) : undefined;
}

export function listSeasons(db: Database.Database, guildId: string): Season[] {
  const rows = db
    .prepare('SELECT * FROM seasons WHERE guild_id = ? ORDER BY season_number ASC')
    .all(guildId) as SeasonRow[];

  return rows.map(toSeason);
}

// Deactivates whatever season is currently active (if any) and activates
// `seasonId`, in one transaction. Doing this in two steps rather than a
// single UPDATE is what lets idx_seasons_one_active_per_guild (a partial
// UNIQUE index on status = 'active') stay satisfied at every intermediate
// point, rather than briefly having two active rows.
//
// If `seasonId` doesn't exist (or belongs to another guild), the activating
// UPDATE matches zero rows without erroring on its own -- so this throws
// explicitly *inside* the transaction in that case, which rolls the
// deactivation back too. Without that, a bad seasonId would silently leave
// the guild with no active season at all before the caller ever saw an
// error.
export function setActiveSeason(db: Database.Database, guildId: string, seasonId: number): Season {
  const activate = db.transaction((targetSeasonId: number) => {
    db.prepare("UPDATE seasons SET status = 'inactive' WHERE guild_id = ? AND status = 'active'").run(guildId);

    const result = db
      .prepare("UPDATE seasons SET status = 'active' WHERE id = ? AND guild_id = ?")
      .run(targetSeasonId, guildId);

    if (result.changes === 0) {
      throw new Error(`Season ${targetSeasonId} not found for guild ${guildId}`);
    }
  });

  activate(seasonId);

  const row = db.prepare('SELECT * FROM seasons WHERE id = ? AND guild_id = ?').get(seasonId, guildId) as
    | SeasonRow
    | undefined;

  if (!row) throw new Error(`Season ${seasonId} not found for guild ${guildId}`);
  return toSeason(row);
}

export function setSeasonDiscordCategoryId(db: Database.Database, seasonId: number, discordCategoryId: string): void {
  db.prepare('UPDATE seasons SET discord_category_id = ? WHERE id = ?').run(discordCategoryId, seasonId);
}
