import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { closeDatabase, openDatabase } from './client.js';
import { migrations } from './migrations.js';
import {
  activateSeasonIfNoneActive,
  createSeason,
  getActiveManagedResourceByLogicalKey,
  getActiveSeason,
  getDivisionByKey,
  getManagedResourceByDiscordId,
  getSeasonByNumber,
  insertManagedResource,
  SeasonAlreadyActiveError,
  setActiveSeason,
  setDivisionStatus,
  setManagedResourceParent,
  upsertDivision,
} from './index.js';

let tempDir: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ratatoskr-db-test-'));
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('fresh database initializes successfully', () => {
  const dbPath = join(tempDir, 'fresh.db');
  const db = openDatabase(dbPath);
  try {
    assert.ok(existsSync(dbPath), 'database file should exist on disk');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const expected of [
      'managed_resources',
      'seasons',
      'divisions',
      'scout_config',
      'scout_setups',
      'scout_signups',
      'scout_roster_slots',
      'scout_coordination',
      'scout_game_hosts',
      'scout_events',
      'scout_notifications',
      'schema_migrations',
    ]) {
      assert.ok(tables.includes(expected), `expected table "${expected}" to exist`);
    }
  } finally {
    closeDatabase(db);
  }
});

test('migrations are idempotent across repeated startups against the same file', () => {
  const dbPath = join(tempDir, 'idempotent.db');

  const first = openDatabase(dbPath);
  closeDatabase(first);

  const second = openDatabase(dbPath);
  try {
    const rows = second.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: number }[];
    const ids = rows.map((row) => row.id);
    assert.deepEqual(ids, [...new Set(ids)], 'schema_migrations must not contain duplicate migration ids');
    assert.ok(ids.length > 0, 'at least one migration should be recorded');
  } finally {
    closeDatabase(second);
  }
});

test('process restart against the same database preserves inserted state', () => {
  const dbPath = join(tempDir, 'restart.db');

  const beforeRestart = openDatabase(dbPath);
  insertManagedResource(beforeRestart, {
    discordResourceId: 'channel-1',
    guildId: 'guild-1',
    resourceType: 'text_channel',
    logicalKey: 'server:welcome:channel',
    scaffoldDomain: 'server',
  });
  closeDatabase(beforeRestart);

  const afterRestart = openDatabase(dbPath);
  try {
    const resource = getManagedResourceByDiscordId(afterRestart, 'guild-1', 'channel-1');
    assert.ok(resource, 'resource inserted before restart should survive a reopen of the same file');
    assert.equal(resource?.logicalKey, 'server:welcome:channel');
  } finally {
    closeDatabase(afterRestart);
  }
});

test('managed_resources accepts the widened resource_type/status CHECK values (#31 Decision 1 / migration 2)', () => {
  // Migration 2 rebuilds managed_resources to widen resource_type with
  // 'emoji' and status with 'archived'/'purged'. No production code writes
  // these yet, but nothing else exercises the widened CHECK constraint
  // itself -- this proves the rebuilt table's CHECK actually accepts them,
  // rather than relying on the CREATE TABLE SQL being eyeballed correct.
  const db = openDatabase(join(tempDir, 'widened-enum.db'));
  try {
    const inserted = insertManagedResource(db, {
      discordResourceId: 'emoji-1',
      guildId: 'guild-1',
      resourceType: 'emoji',
      logicalKey: 'server:emoji:test',
      scaffoldDomain: 'server',
    });
    assert.equal(inserted.resourceType, 'emoji');

    for (const status of ['archived', 'purged'] as const) {
      assert.doesNotThrow(() => {
        db.prepare('UPDATE managed_resources SET status = ? WHERE id = ?').run(status, inserted.id);
      }, `status '${status}' should be accepted by the widened CHECK constraint`);
    }
  } finally {
    closeDatabase(db);
  }
});

test('migration 2 renames season channel keys for every season number, not just season 1', () => {
  // Codex review finding on this PR: the original migration hardcoded
  // `season:1:...` renames only. /season create accepts any positive season
  // number, so a deployment that already provisioned season 2+ before this
  // upgrade would have left those rows under the old key format -- a retry
  // then misses the renamed key, re-adopts the same Discord channel under
  // the "new" row, and violates UNIQUE (guild_id, discord_resource_id). The
  // fix rewrites the fixed, known suffix via LIKE + REPLACE instead of a
  // hardcoded season number, so it isn't scoped to season 1 at all.
  const db = new Database(':memory:');
  try {
    db.exec(migrations[0].sql); // 'init' only -- pre-key-authoring schema.

    const insertOldRow = db.prepare(`
      INSERT INTO managed_resources (discord_resource_id, guild_id, resource_type, logical_key, scaffold_domain)
      VALUES (?, ?, 'text_channel', ?, 'season')
    `);
    insertOldRow.run('season1-schedule', 'guild-1', 'season:1:schedule:text_channel');
    insertOldRow.run('season2-schedule', 'guild-1', 'season:2:schedule:text_channel');
    insertOldRow.run('season7-rosters', 'guild-1', 'season:7:rosters:text_channel');

    db.exec(migrations[1].sql); // 'authored_logical_keys_and_widened_lifecycle'.

    const rows = db
      .prepare('SELECT discord_resource_id, logical_key FROM managed_resources ORDER BY discord_resource_id')
      .all() as { discord_resource_id: string; logical_key: string }[];

    assert.deepEqual(
      rows.map((row) => row.logical_key),
      [
        'season:1:channel:schedule:text_channel',
        'season:2:channel:schedule:text_channel',
        'season:7:channel:rosters:text_channel',
      ],
    );
  } finally {
    db.close();
  }
});

test('migration 9 preserves existing scout data while adding optional Fill signups', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const migration of migrations.slice(0, 8)) db.exec(migration.sql);
    db.prepare("INSERT INTO scout_config (guild_id, solo_emoji_id) VALUES ('guild-1', 'solo-emoji')").run();
    db.prepare(`
      INSERT INTO divisions (guild_id, division_key, display_name)
      VALUES ('guild-1', 'vanaheim', 'Vanaheim')
    `).run();
    const division = db.prepare("SELECT id FROM divisions WHERE guild_id = 'guild-1'").get() as { id: number };
    const setup = db.prepare(`
      INSERT INTO scout_setups (
        guild_id, division_id, division_key, division_display_name, created_by,
        signup_channel_id, results_channel_id, division_role_id,
        solo_emoji_id, jungle_emoji_id, mid_emoji_id, support_emoji_id, carry_emoji_id,
        start_at, role_limit
      ) VALUES ('guild-1', ?, 'vanaheim', 'Vanaheim', 'captain-1', 'signups', 'results', 'division-role',
        'solo', 'jungle', 'mid', 'support', 'carry', 2000000000, 2)
      RETURNING id
    `).get(division.id) as { id: number };
    db.prepare("INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, 'existing-player', 'solo')").run(setup.id);

    db.exec(migrations[8]!.sql);

    assert.equal(
      (db.prepare("SELECT role FROM scout_signups WHERE user_id = 'existing-player'").get() as { role: string }).role,
      'solo',
    );
    assert.doesNotThrow(() => {
      db.prepare("INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, 'fill-player', 'fill')").run(setup.id);
    });
    assert.equal(
      (db.prepare("SELECT fill_emoji_id FROM scout_config WHERE guild_id = 'guild-1'").get() as { fill_emoji_id: string | null }).fill_emoji_id,
      null,
    );
    assert.equal(
      (db.prepare('SELECT fill_emoji_id FROM scout_setups WHERE id = ?').get(setup.id) as { fill_emoji_id: string | null }).fill_emoji_id,
      null,
    );
  } finally {
    db.close();
  }
});

test('migration 11 preserves existing one-game roster slots', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const migration of migrations.slice(0, 10)) db.exec(migration.sql);
    db.prepare(`INSERT INTO divisions (guild_id, division_key, display_name)
      VALUES ('guild-1', 'vanaheim', 'Vanaheim')`).run();
    const division = db.prepare("SELECT id FROM divisions WHERE guild_id = 'guild-1'").get() as { id: number };
    const setup = db.prepare(`INSERT INTO scout_setups (
      guild_id, division_id, division_key, division_display_name, created_by,
      signup_channel_id, results_channel_id, division_role_id,
      solo_emoji_id, jungle_emoji_id, mid_emoji_id, support_emoji_id, carry_emoji_id,
      start_at, role_limit, status
    ) VALUES ('guild-1', ?, 'vanaheim', 'Vanaheim', 'captain-1', 'signups', 'results', 'division-role',
      'solo', 'jungle', 'mid', 'support', 'carry', 2000000000, 2, 'roster_ready') RETURNING id`).get(division.id) as { id: number };
    db.prepare(`INSERT INTO scout_roster_slots (setup_id, team, role, user_id, staff_assigned)
      VALUES (?, 'team_one', 'solo', 'existing-player', 1)`).run(setup.id);

    db.exec(migrations[10]!.sql);

    assert.deepEqual(
      db.prepare('SELECT game_number, user_id, staff_assigned FROM scout_roster_slots WHERE setup_id = ?').get(setup.id),
      { game_number: 1, user_id: 'existing-player', staff_assigned: 1 },
    );
    assert.equal(
      (db.prepare('SELECT game_count FROM scout_setups WHERE id = ?').get(setup.id) as { game_count: number }).game_count,
      1,
    );
  } finally {
    db.close();
  }
});

test('managed resources can be inserted and read back by Discord ID and logical key', () => {
  const db = openDatabase(join(tempDir, 'managed-resources.db'));
  try {
    const inserted = insertManagedResource(db, {
      discordResourceId: 'category-42',
      guildId: 'guild-1',
      resourceType: 'category',
      logicalKey: 'division:vanaheim:category',
      scaffoldDomain: 'division',
    });

    const byDiscordId = getManagedResourceByDiscordId(db, 'guild-1', 'category-42');
    assert.equal(byDiscordId?.id, inserted.id);
    assert.equal(byDiscordId?.status, 'active');

    const byLogicalKey = getActiveManagedResourceByLogicalKey(db, 'guild-1', 'division:vanaheim:category');
    assert.equal(byLogicalKey?.id, inserted.id);

    const missing = getManagedResourceByDiscordId(db, 'guild-1', 'does-not-exist');
    assert.equal(missing, undefined);
  } finally {
    closeDatabase(db);
  }
});

test('season identity keeps season_number, display_name, and category_name independent', () => {
  const db = openDatabase(join(tempDir, 'season-identity.db'));
  try {
    const named = createSeason(db, {
      guildId: 'guild-1',
      seasonNumber: 2,
      displayName: 'Season of the Tree',
    });
    assert.equal(named.seasonNumber, 2);
    assert.equal(named.displayName, 'Season of the Tree');
    assert.equal(named.categoryName, 'Season of the Tree');

    const unnamed = createSeason(db, {
      guildId: 'guild-1',
      seasonNumber: 3,
    });
    assert.equal(unnamed.seasonNumber, 3);
    assert.equal(unnamed.displayName, null);
    assert.equal(unnamed.categoryName, 'YSL Season 3');

    const rereadNamed = getSeasonByNumber(db, 'guild-1', 2);
    assert.equal(rereadNamed?.displayName, 'Season of the Tree');
    const rereadUnnamed = getSeasonByNumber(db, 'guild-1', 3);
    assert.equal(rereadUnnamed?.displayName, null);
    assert.equal(rereadUnnamed?.categoryName, 'YSL Season 3');
  } finally {
    closeDatabase(db);
  }
});

test('exactly one season can be active at a time per guild', () => {
  const db = openDatabase(join(tempDir, 'active-season.db'));
  try {
    const seasonOne = createSeason(db, { guildId: 'guild-1', seasonNumber: 1 });
    const seasonTwo = createSeason(db, { guildId: 'guild-1', seasonNumber: 2, displayName: 'Season of the Tree' });

    assert.equal(getActiveSeason(db, 'guild-1'), undefined, 'no season is active until explicitly set');

    setActiveSeason(db, 'guild-1', seasonOne.id);
    assert.equal(getActiveSeason(db, 'guild-1')?.id, seasonOne.id);

    setActiveSeason(db, 'guild-1', seasonTwo.id);
    const active = getActiveSeason(db, 'guild-1');
    assert.equal(active?.id, seasonTwo.id, 'activating a new season should deactivate the previous one');

    const stale = getSeasonByNumber(db, 'guild-1', 1);
    assert.equal(stale?.status, 'inactive');
  } finally {
    closeDatabase(db);
  }
});

test('activating a nonexistent season throws without deactivating the current one', () => {
  const db = openDatabase(join(tempDir, 'active-season-invalid-target.db'));
  try {
    const seasonOne = createSeason(db, { guildId: 'guild-1', seasonNumber: 1 });
    setActiveSeason(db, 'guild-1', seasonOne.id);

    assert.throws(() => {
      setActiveSeason(db, 'guild-1', 999999);
    }, /not found/);

    const active = getActiveSeason(db, 'guild-1');
    assert.equal(
      active?.id,
      seasonOne.id,
      'a failed activation must not leave the guild with zero active seasons',
    );
  } finally {
    closeDatabase(db);
  }
});

test('activateSeasonIfNoneActive activates a season when none is currently active', () => {
  const db = openDatabase(join(tempDir, 'activate-if-none-active.db'));
  try {
    const season = createSeason(db, { guildId: 'guild-1', seasonNumber: 1 });
    assert.equal(getActiveSeason(db, 'guild-1'), undefined);

    const activated = activateSeasonIfNoneActive(db, 'guild-1', season.id);
    assert.equal(activated.status, 'active');
    assert.equal(getActiveSeason(db, 'guild-1')?.id, season.id);
  } finally {
    closeDatabase(db);
  }
});

test('activateSeasonIfNoneActive throws and touches nothing when a season is already active -- it never replaces it', () => {
  const db = openDatabase(join(tempDir, 'activate-if-none-active-conflict.db'));
  try {
    const seasonOne = createSeason(db, { guildId: 'guild-1', seasonNumber: 1 });
    const seasonTwo = createSeason(db, { guildId: 'guild-1', seasonNumber: 2 });
    activateSeasonIfNoneActive(db, 'guild-1', seasonOne.id);

    assert.throws(
      () => activateSeasonIfNoneActive(db, 'guild-1', seasonTwo.id),
      (error: unknown) => error instanceof SeasonAlreadyActiveError && error.activeSeasonNumber === 1,
    );

    assert.equal(getActiveSeason(db, 'guild-1')?.id, seasonOne.id, 'the already-active season must be untouched');
    assert.equal(getSeasonByNumber(db, 'guild-1', 2)?.status, 'inactive', 'the loser must stay inactive, not partially activated');
  } finally {
    closeDatabase(db);
  }
});

test('division persistence reconciles by (guildId, divisionKey) without duplicating rows', () => {
  const db = openDatabase(join(tempDir, 'divisions.db'));
  try {
    upsertDivision(db, { guildId: 'guild-1', divisionKey: 'vanaheim', displayName: 'Vanaheim', roleId: 'role-1' });
    upsertDivision(db, {
      guildId: 'guild-1',
      divisionKey: 'vanaheim',
      displayName: 'Vanaheim',
      roleId: 'role-1',
      categoryId: 'category-1',
    });

    const rows = db.prepare('SELECT COUNT(*) AS count FROM divisions WHERE guild_id = ?').get('guild-1') as {
      count: number;
    };
    assert.equal(rows.count, 1, 'reconciling the same division twice must not create a second row');

    const division = getDivisionByKey(db, 'guild-1', 'vanaheim');
    assert.equal(division?.categoryId, 'category-1');
  } finally {
    closeDatabase(db);
  }
});

test('divisions table identifies rows by division_key, not division_name (migration 3 / #31 Defect 1)', () => {
  const db = openDatabase(join(tempDir, 'divisions-schema.db'));
  try {
    const columns = (db.prepare('PRAGMA table_info(divisions)').all() as { name: string }[]).map((col) => col.name);
    assert.ok(columns.includes('division_key'), 'divisions table must have a division_key column');
    assert.ok(columns.includes('display_name'), 'divisions table must have a display_name column');
    assert.ok(!columns.includes('division_name'), 'the old division_name column must be gone, not left alongside the new one');
  } finally {
    closeDatabase(db);
  }
});

test('managed channel parent tracking follows an ID-preserving move', () => {
  const db = openDatabase(join(tempDir, 'managed-resource-parent.db'));
  try {
    const resource = insertManagedResource(db, {
      discordResourceId: 'channel-1',
      guildId: 'guild-1',
      resourceType: 'text_channel',
      logicalKey: 'division:vanaheim:channel:scout_signups:text_channel',
      parentResourceId: 'vanaheim-category',
      scaffoldDomain: 'division',
    });
    setManagedResourceParent(db, resource.id, 'scout-ops-category');
    assert.equal(
      getActiveManagedResourceByLogicalKey(db, 'guild-1', resource.logicalKey)?.parentResourceId,
      'scout-ops-category',
    );
  } finally {
    closeDatabase(db);
  }
});

test('division permission roles are stored as manager and captain roles without the obsolete access suffix', () => {
  const db = openDatabase(join(tempDir, 'division-permission-roles-schema.db'));
  try {
    const columns = (db.prepare('PRAGMA table_info(divisions)').all() as { name: string }[]).map((column) => column.name);
    assert.ok(columns.includes('manager_role_id'));
    assert.ok(columns.includes('captain_role_id'));
    assert.ok(!columns.includes('captain_access_role_id'));
  } finally {
    closeDatabase(db);
  }
});

test('upsertDivision: a config-side display-name rename (key unchanged) updates display_name in place -- never a duplicate row -- and role/category ids stay linked (#31 Defect 1/Defect 2)', () => {
  const db = openDatabase(join(tempDir, 'divisions-rename.db'));
  try {
    upsertDivision(db, {
      guildId: 'guild-1',
      divisionKey: 'vanaheim',
      displayName: 'Vanaheim',
      roleId: 'role-1',
      managerRoleId: 'manager-role-1',
      captainRoleId: 'captain-role-1',
      categoryId: 'category-1',
    });

    // Simulates re-provisioning after only guild-structure.ts's division
    // `name` changed -- the key a real reconciliation run would still pass
    // is identical, because it comes from config, not from the old row.
    const afterRename = upsertDivision(db, {
      guildId: 'guild-1',
      divisionKey: 'vanaheim',
      displayName: 'Vanir Prime',
      roleId: 'role-1',
      managerRoleId: 'manager-role-1',
      captainRoleId: 'captain-role-1',
      categoryId: 'category-1',
    });

    const rows = db.prepare('SELECT COUNT(*) AS count FROM divisions WHERE guild_id = ?').get('guild-1') as { count: number };
    assert.equal(rows.count, 1, 'a display-name-only rename must never create a second row');
    assert.equal(afterRename.displayName, 'Vanir Prime');
    assert.equal(afterRename.roleId, 'role-1', 'the existing managed role stays linked across the rename');
    assert.equal(afterRename.categoryId, 'category-1', 'the existing managed category stays linked across the rename');
  } finally {
    closeDatabase(db);
  }
});

test('upsertDivision resets an archived division back to active -- provisioning restores active-state permissions, so the record must not keep claiming archived (Codex review on #33)', () => {
  const db = openDatabase(join(tempDir, 'divisions-reactivate.db'));
  try {
    upsertDivision(db, { guildId: 'guild-1', divisionKey: 'vanaheim', displayName: 'Vanaheim', roleId: 'role-1', categoryId: 'category-1' });
    setDivisionStatus(db, 'guild-1', 'vanaheim', 'archived');

    const archived = getDivisionByKey(db, 'guild-1', 'vanaheim');
    assert.equal(archived?.status, 'archived');

    // Re-running provisioning (e.g. /division add) unconditionally restores
    // active-state permission overwrites -- if the row still said 'archived'
    // afterward, /division delete's "must be archived first" safety gate
    // would pass against a division that is, in reality, no longer hidden.
    const reprovisioned = upsertDivision(db, {
      guildId: 'guild-1',
      divisionKey: 'vanaheim',
      displayName: 'Vanaheim',
      roleId: 'role-1',
      categoryId: 'category-1',
    });
    assert.equal(reprovisioned.status, 'active', 'provisioning must reset status to active, not leave it archived');
  } finally {
    closeDatabase(db);
  }
});

test('opening a database at an unwritable path fails clearly instead of falling back silently', () => {
  const blockingFilePath = join(tempDir, 'not-a-directory');
  writeFileSync(blockingFilePath, 'this is a file, not a directory');
  const impossiblePath = join(blockingFilePath, 'nested', 'ratatoskr.db');

  assert.throws(() => {
    openDatabase(impossiblePath);
  }, /Cannot create directory/);
});

test('resolveDatabasePath never resolves to an in-memory database', async () => {
  const { resolveDatabasePath } = await import('./client.js');
  const originalPath = process.env.DATABASE_PATH;
  try {
    delete process.env.DATABASE_PATH;
    assert.notEqual(resolveDatabasePath(), ':memory:');

    process.env.DATABASE_PATH = '/data/ratatoskr.db';
    assert.equal(resolveDatabasePath(), '/data/ratatoskr.db');
  } finally {
    if (originalPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalPath;
  }
});
