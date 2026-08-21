export type Migration = {
  id: number;
  name: string;
  sql: string;
};

// Centralized, append-only migration list. Each migration runs at most once
// per database (tracked in schema_migrations) and never mutates prior
// entries -- to change a table shape, add a new numbered migration rather
// than editing an already-shipped one.
//
// archive_jobs is intentionally not created yet: its shape depends on the
// still-unimplemented historical export pipeline, so it's reserved for a
// future migration rather than guessed at now.
export const migrations: Migration[] = [
  {
    id: 1,
    name: 'init',
    sql: `
      CREATE TABLE managed_resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_resource_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('role', 'category', 'text_channel', 'voice_channel')),
        logical_key TEXT NOT NULL,
        parent_resource_id TEXT,
        scaffold_domain TEXT NOT NULL CHECK (scaffold_domain IN ('server', 'season', 'division')),
        scaffold_version TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'obsolete')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (guild_id, discord_resource_id)
      );

      -- At most one *active* managed resource may occupy a given logical key
      -- per guild. Obsolete rows are kept for history/audit, so this is a
      -- partial index rather than a plain UNIQUE column.
      CREATE UNIQUE INDEX idx_managed_resources_active_logical_key
        ON managed_resources (guild_id, logical_key)
        WHERE status = 'active';

      CREATE INDEX idx_managed_resources_guild_domain
        ON managed_resources (guild_id, scaffold_domain, status);

      CREATE TABLE seasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        season_number INTEGER NOT NULL,
        display_name TEXT,
        category_name TEXT NOT NULL,
        discord_category_id TEXT,
        status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive', 'archived')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        archived_at TEXT,
        UNIQUE (guild_id, season_number)
      );

      -- Enforces "exactly one active season" at the database level, not just
      -- in application code.
      CREATE UNIQUE INDEX idx_seasons_one_active_per_guild
        ON seasons (guild_id)
        WHERE status = 'active';

      CREATE TABLE divisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        division_name TEXT NOT NULL,
        season_id INTEGER REFERENCES seasons (id),
        role_id TEXT,
        captain_access_role_id TEXT,
        category_id TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (guild_id, division_name)
      );
    `,
  },
];
