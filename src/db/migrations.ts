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
  {
    id: 2,
    name: 'authored_logical_keys_and_widened_lifecycle',
    // Two things happen here, per the Ratatoskr Hardening Master Plan (#31):
    //
    // 1. Rename every currently-derivable logical_key from the old
    //    name-derived format (`server:<slugified-name>:...`) to the new
    //    authored-key format (`server:role:<key>`, `server:category:<key>`,
    //    `server:channel:<categoryKey>:<channelKey>:<kind>`,
    //    `season:<N>:channel:<key>:text_channel`). This transforms only
    //    logical_key values already present in managed_resources -- it does
    //    not infer, reconstruct, or fabricate a row for a key that should
    //    exist but doesn't. A missing expected row surfaces afterward as a
    //    normal `create` line in reconciliation output; that's
    //    reconciliation's job, not this migration's. Each UPDATE is a no-op
    //    if the old key has no row (e.g. a fresh database), so this is safe
    //    to run against any environment.
    //
    //    Season channel keys are scoped to season 1 specifically: at the
    //    time of writing, no other season number has ever been created. If
    //    a deployment somehow has other season numbers with rows under the
    //    old key format, those would need their own pair added here -- this
    //    migration does not attempt to discover season numbers dynamically,
    //    to keep the mapping explicit, finite, and reviewable rather than a
    //    second reconciliation engine embedded in a migration.
    //
    // 2. Widen two CHECK constraints by rebuilding the table (SQLite cannot
    //    ALTER a CHECK constraint in place): `status` gains 'archived' and
    //    'purged' (#31 Decision 1 -- unused by any code yet, land with
    //    archive/#7 and a future purge command respectively); `resource_type`
    //    gains 'emoji' only (#31 §7 -- also unused yet; 'forum_channel' is
    //    deliberately not added, no current or approved use case).
    sql: `
      UPDATE managed_resources SET logical_key = 'server:role:allfather' WHERE logical_key = 'server:allfather:role';
      UPDATE managed_resources SET logical_key = 'server:role:aesir' WHERE logical_key = 'server:aesir:role';
      UPDATE managed_resources SET logical_key = 'server:role:valkyries' WHERE logical_key = 'server:valkyries:role';
      UPDATE managed_resources SET logical_key = 'server:role:production' WHERE logical_key = 'server:production:role';
      UPDATE managed_resources SET logical_key = 'server:role:org_owner' WHERE logical_key = 'server:org-owner:role';
      UPDATE managed_resources SET logical_key = 'server:role:captain' WHERE logical_key = 'server:captain:role';
      UPDATE managed_resources SET logical_key = 'server:role:player' WHERE logical_key = 'server:player:role';
      UPDATE managed_resources SET logical_key = 'server:role:free_agent' WHERE logical_key = 'server:free-agent:role';

      UPDATE managed_resources SET logical_key = 'server:category:welcome' WHERE logical_key = 'server:welcome:category';
      UPDATE managed_resources SET logical_key = 'server:category:league_information' WHERE logical_key = 'server:league-information:category';
      UPDATE managed_resources SET logical_key = 'server:category:community' WHERE logical_key = 'server:community:category';
      UPDATE managed_resources SET logical_key = 'server:category:org_owners' WHERE logical_key = 'server:org-owners:category';
      UPDATE managed_resources SET logical_key = 'server:category:production' WHERE logical_key = 'server:production:category';
      UPDATE managed_resources SET logical_key = 'server:category:admin' WHERE logical_key = 'server:admin:category';

      UPDATE managed_resources SET logical_key = 'server:channel:welcome:welcome:text_channel' WHERE logical_key = 'server:welcome:welcome:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:welcome:rules:text_channel' WHERE logical_key = 'server:welcome:rules:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:welcome:announcements:text_channel' WHERE logical_key = 'server:welcome:announcements:text_channel';

      UPDATE managed_resources SET logical_key = 'server:channel:league_information:about_ysl:text_channel' WHERE logical_key = 'server:league-information:about-ysl:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:league_information:league_rules:text_channel' WHERE logical_key = 'server:league-information:league-rules:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:league_information:faq:text_channel' WHERE logical_key = 'server:league-information:faq:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:league_information:sign_ups:text_channel' WHERE logical_key = 'server:league-information:sign-ups:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:league_information:patch_notes:text_channel' WHERE logical_key = 'server:league-information:patch-notes:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:league_information:role_select:text_channel' WHERE logical_key = 'server:league-information:role-select:text_channel';

      UPDATE managed_resources SET logical_key = 'server:channel:community:general:text_channel' WHERE logical_key = 'server:community:general:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:community:smite_chat:text_channel' WHERE logical_key = 'server:community:smite-chat:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:community:lfg:text_channel' WHERE logical_key = 'server:community:lfg:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:community:self_promo:text_channel' WHERE logical_key = 'server:community:self-promo:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:community:clips_and_highlights:text_channel' WHERE logical_key = 'server:community:clips-and-highlights:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:community:general_voice:voice_channel' WHERE logical_key = 'server:community:general:voice_channel';

      UPDATE managed_resources SET logical_key = 'server:channel:org_owners:org_owner_lounge:text_channel' WHERE logical_key = 'server:org-owners:org-owner-lounge:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:org_owners:org_admin_discussion:text_channel' WHERE logical_key = 'server:org-owners:org-admin-discussion:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:org_owners:org_owner_meeting:voice_channel' WHERE logical_key = 'server:org-owners:org-owner-meeting:voice_channel';

      UPDATE managed_resources SET logical_key = 'server:channel:production:production_chat:text_channel' WHERE logical_key = 'server:production:production-chat:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:production:broadcast_planning:text_channel' WHERE logical_key = 'server:production:broadcast-planning:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:production:org_graphics:text_channel' WHERE logical_key = 'server:production:org-graphics:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:production:production_room:voice_channel' WHERE logical_key = 'server:production:production-room:voice_channel';

      UPDATE managed_resources SET logical_key = 'server:channel:admin:meeting_of_the_minds:text_channel' WHERE logical_key = 'server:admin:meeting-of-the-minds:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:admin:staff_ops:text_channel' WHERE logical_key = 'server:admin:staff-ops:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:admin:audit_log:text_channel' WHERE logical_key = 'server:admin:audit-log:text_channel';
      UPDATE managed_resources SET logical_key = 'server:channel:admin:staff_room:voice_channel' WHERE logical_key = 'server:admin:staff-room:voice_channel';

      UPDATE managed_resources SET logical_key = 'season:1:channel:banned_content:text_channel' WHERE logical_key = 'season:1:banned-content:text_channel';
      UPDATE managed_resources SET logical_key = 'season:1:channel:schedule:text_channel' WHERE logical_key = 'season:1:schedule:text_channel';
      UPDATE managed_resources SET logical_key = 'season:1:channel:standings:text_channel' WHERE logical_key = 'season:1:standings:text_channel';
      UPDATE managed_resources SET logical_key = 'season:1:channel:rosters:text_channel' WHERE logical_key = 'season:1:rosters:text_channel';
      UPDATE managed_resources SET logical_key = 'season:1:channel:transactions:text_channel' WHERE logical_key = 'season:1:transactions:text_channel';

      CREATE TABLE managed_resources_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_resource_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('role', 'category', 'text_channel', 'voice_channel', 'emoji')),
        logical_key TEXT NOT NULL,
        parent_resource_id TEXT,
        scaffold_domain TEXT NOT NULL CHECK (scaffold_domain IN ('server', 'season', 'division')),
        scaffold_version TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'obsolete', 'archived', 'purged')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (guild_id, discord_resource_id)
      );

      INSERT INTO managed_resources_new SELECT * FROM managed_resources;

      DROP TABLE managed_resources;
      ALTER TABLE managed_resources_new RENAME TO managed_resources;

      CREATE UNIQUE INDEX idx_managed_resources_active_logical_key
        ON managed_resources (guild_id, logical_key)
        WHERE status = 'active';

      CREATE INDEX idx_managed_resources_guild_domain
        ON managed_resources (guild_id, scaffold_domain, status);
    `,
  },
];
