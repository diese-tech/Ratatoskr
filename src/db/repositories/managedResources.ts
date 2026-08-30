import type Database from 'better-sqlite3';
import type {
  ManagedResource,
  ManagedResourceScaffoldDomain,
  ManagedResourceStatus,
  ManagedResourceType,
} from '../types.js';

type ManagedResourceRow = {
  id: number;
  discord_resource_id: string;
  guild_id: string;
  resource_type: ManagedResourceType;
  logical_key: string;
  parent_resource_id: string | null;
  scaffold_domain: ManagedResourceScaffoldDomain;
  scaffold_version: string | null;
  status: ManagedResourceStatus;
  created_at: string;
  updated_at: string;
};

function toManagedResource(row: ManagedResourceRow): ManagedResource {
  return {
    id: row.id,
    discordResourceId: row.discord_resource_id,
    guildId: row.guild_id,
    resourceType: row.resource_type,
    logicalKey: row.logical_key,
    parentResourceId: row.parent_resource_id,
    scaffoldDomain: row.scaffold_domain,
    scaffoldVersion: row.scaffold_version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type InsertManagedResourceInput = {
  discordResourceId: string;
  guildId: string;
  resourceType: ManagedResourceType;
  logicalKey: string;
  parentResourceId?: string | null;
  scaffoldDomain: ManagedResourceScaffoldDomain;
  scaffoldVersion?: string | null;
};

// Registers a Discord resource Ratatoskr created or explicitly adopted. Only
// resources recorded here are eligible for future automated cleanup --
// nothing about a Discord resource's mere existence (or absence from a
// template) makes it "managed."
export function insertManagedResource(db: Database.Database, input: InsertManagedResourceInput): ManagedResource {
  const row = db
    .prepare(
      `
      INSERT INTO managed_resources (
        discord_resource_id, guild_id, resource_type, logical_key,
        parent_resource_id, scaffold_domain, scaffold_version
      ) VALUES (@discordResourceId, @guildId, @resourceType, @logicalKey,
                @parentResourceId, @scaffoldDomain, @scaffoldVersion)
      RETURNING *;
      `,
    )
    .get({
      discordResourceId: input.discordResourceId,
      guildId: input.guildId,
      resourceType: input.resourceType,
      logicalKey: input.logicalKey,
      parentResourceId: input.parentResourceId ?? null,
      scaffoldDomain: input.scaffoldDomain,
      scaffoldVersion: input.scaffoldVersion ?? null,
    }) as ManagedResourceRow;

  return toManagedResource(row);
}

export function getManagedResourceByDiscordId(
  db: Database.Database,
  guildId: string,
  discordResourceId: string,
): ManagedResource | undefined {
  const row = db
    .prepare('SELECT * FROM managed_resources WHERE guild_id = ? AND discord_resource_id = ?')
    .get(guildId, discordResourceId) as ManagedResourceRow | undefined;

  return row ? toManagedResource(row) : undefined;
}

// Looks up the current *active* resource for a logical key (e.g.
// "division:Crown:category"). Obsolete history for the same key is not
// returned, since callers of this function want "what currently fills this
// role," not the full history.
export function getActiveManagedResourceByLogicalKey(
  db: Database.Database,
  guildId: string,
  logicalKey: string,
): ManagedResource | undefined {
  const row = db
    .prepare("SELECT * FROM managed_resources WHERE guild_id = ? AND logical_key = ? AND status = 'active'")
    .get(guildId, logicalKey) as ManagedResourceRow | undefined;

  return row ? toManagedResource(row) : undefined;
}

export function listManagedResourcesByDomain(
  db: Database.Database,
  guildId: string,
  scaffoldDomain: ManagedResourceScaffoldDomain,
  status?: ManagedResourceStatus,
): ManagedResource[] {
  const rows = status
    ? (db
        .prepare('SELECT * FROM managed_resources WHERE guild_id = ? AND scaffold_domain = ? AND status = ?')
        .all(guildId, scaffoldDomain, status) as ManagedResourceRow[])
    : (db
        .prepare('SELECT * FROM managed_resources WHERE guild_id = ? AND scaffold_domain = ?')
        .all(guildId, scaffoldDomain) as ManagedResourceRow[]);

  return rows.map(toManagedResource);
}

// Flips a managed resource to obsolete without deleting its row -- future
// cleanup workflows read this status to build a deletion preview; they never
// infer obsolescence from a resource's mere absence elsewhere.
export function markManagedResourceObsolete(db: Database.Database, id: number): void {
  db.prepare("UPDATE managed_resources SET status = 'obsolete', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
    id,
  );
}

// Flips a managed resource to purged after its underlying Discord resource
// has actually been destroyed (#31 Decision 1) -- the row itself is kept as
// a tombstone, never hard-deleted. Distinct from markManagedResourceObsolete,
// which means "no longer the current template's resource" but the Discord
// resource may still exist; purged specifically means Ratatoskr destroyed it.
export function markManagedResourcePurged(db: Database.Database, id: number): void {
  db.prepare("UPDATE managed_resources SET status = 'purged', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
    id,
  );
}
