import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrations } from './migrations.js';
import { openDatabase } from './client.js';
import { createScoutSetup } from './repositories/scoutSetups.js';

function withoutFoundationSlotColumns(rows: unknown[]): unknown[] {
  return rows.map((item) => {
    const row = item as Record<string, unknown>;
    const {
      off_role: _offRole,
      assigned_by_user_id: _assignedBy,
      replacement_needed: _replacementNeeded,
      replacement_requested_at: _replacementRequestedAt,
      ...legacy
    } = row;
    return legacy;
  });
}

for (const version of [14, 15, 16, 17, 18]) test(`v${version} disk upgrade preserves active, pending and historical Scout routing and rows`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'ratatoskr-upgrade-'));
  const path = join(directory, `v${version}.db`);
  const legacy = new Database(path);
  const tables = ['divisions', 'scout_setups', 'scout_signups', 'scout_roster_slots'];
  let snapshot: unknown[];
  try {
    legacy.pragma('foreign_keys = ON');
    legacy.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    for (const migration of migrations.filter((item) => item.id <= version)) {
      legacy.exec(migration.sql);
      legacy.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(migration.id, migration.name);
    }
    legacy.prepare("INSERT INTO divisions (guild_id, division_key, display_name) VALUES ('guild', 'vanaheim', 'Vanaheim')").run();
    const states = ['posting', 'open', 'roster_ready', 'published', 'published', 'cancelled', 'published'];
    for (const [index, status] of states.entries()) {
      const id = index + 1;
      legacy.prepare(`INSERT INTO scout_setups (
        id, guild_id, division_id, division_key, division_display_name, created_by,
        signup_channel_id, results_channel_id, operations_channel_id, division_role_id,
        solo_emoji_id, jungle_emoji_id, mid_emoji_id, support_emoji_id, carry_emoji_id,
        start_at, role_limit, status, signup_message_id, result_message_id, signup_post_reconciled
      ) VALUES (?, 'guild', 1, 'vanaheim', 'Vanaheim', 'staff', 'signups', 'legacy-rosters', 'ops', 'division',
        'solo', 'jungle', 'mid', 'support', 'carry', 2000000000, 2, ?, ?, ?, ?)`)
        .run(
          id,
          status,
          status === 'posting' ? null : `signup-${id}`,
          index === 4 || index === 6 ? `old-roster-message-${id}` : null,
          index === 4 || index === 6 ? 1 : 0,
        );
      legacy.prepare("INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, 'player', 'solo')").run(id);
      if (version >= 18) {
        legacy.prepare("INSERT INTO scout_coordination (setup_id, organizer_user_id) VALUES (?, 'staff')").run(id);
      }
      if (['roster_ready', 'published'].includes(status)) {
        legacy.prepare("INSERT INTO scout_roster_slots (setup_id, game_number, team, role, user_id) VALUES (?, 1, 'team_one', 'solo', 'player')").run(id);
      }
    }
    if (version >= 15) {
      legacy.prepare('UPDATE scout_setups SET version = 1 WHERE id = 5').run();
      legacy.prepare("INSERT INTO scout_roster_updates (setup_id, version, notice) VALUES (5, 1, 'Pending notice')").run();
      tables.push('scout_roster_updates');
    }
    if (version >= 16) {
      legacy.prepare("INSERT INTO scout_readiness_cards (setup_id, telemetry_message_id, telemetry_attempted) VALUES (2, 'telemetry-2', 1)").run();
      tables.push('scout_readiness_cards');
    }
    if (version >= 17) {
      legacy.prepare("INSERT INTO scout_completions (setup_id, finished_by, posts_reconciled) VALUES (7, 'staff', 1)").run();
      tables.push('scout_completions');
    }
    snapshot = tables.map((table) => legacy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  } finally { legacy.close(); }
  const upgraded = openDatabase(path);
  try {
    const upgradedRows = tables.map((table) => {
      const rows = upgraded.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      return table === 'scout_roster_slots' && version < 18 ? withoutFoundationSlotColumns(rows) : rows;
    });
    assert.deepEqual(upgradedRows, snapshot);
    if (version === 14) assert.deepEqual(upgraded.prepare('SELECT * FROM scout_roster_updates').all(), []);
    if (version < 16) assert.deepEqual(upgraded.prepare('SELECT * FROM scout_readiness_cards').all(), []);
    if (version < 17) assert.deepEqual(upgraded.prepare('SELECT * FROM scout_completions').all(), []);
    assert.equal(
      (upgraded.prepare('SELECT COUNT(*) AS count FROM scout_coordination').get() as { count: number }).count,
      7,
    );
    assert.deepEqual(
      upgraded.prepare('SELECT DISTINCT organizer_user_id FROM scout_coordination').all(),
      [{ organizer_user_id: 'staff' }],
    );
    assert.deepEqual(upgraded.prepare('SELECT * FROM scout_game_hosts').all(), []);
    assert.deepEqual(upgraded.prepare('SELECT * FROM scout_events').all(), []);
    assert.deepEqual(upgraded.prepare('SELECT * FROM scout_notifications').all(), []);
    assert.deepEqual(
      upgraded.prepare(
        `SELECT DISTINCT off_role, assigned_by_user_id, replacement_needed, replacement_requested_at
         FROM scout_roster_slots`,
      ).all(),
      [{ off_role: 0, assigned_by_user_id: null, replacement_needed: 0, replacement_requested_at: null }],
    );
    assert.ok(upgraded.prepare('SELECT id FROM schema_migrations WHERE id = 15').get());
    assert.ok(upgraded.prepare('SELECT id FROM schema_migrations WHERE id = 16').get());
    assert.ok(upgraded.prepare('SELECT id FROM schema_migrations WHERE id = 17').get());
    assert.ok(upgraded.prepare('SELECT id FROM schema_migrations WHERE id = 18').get());
    assert.ok(upgraded.prepare('SELECT id FROM schema_migrations WHERE id = 19').get());
    assert.ok(upgraded.prepare('SELECT id FROM schema_migrations WHERE id = 20').get());
    assert.deepEqual(upgraded.prepare('SELECT * FROM scout_lifecycle_cleanups').all(), []);
    assert.deepEqual(upgraded.prepare('SELECT * FROM scout_lifecycle_recovery_attempts').all(), []);
    assert.deepEqual(upgraded.pragma('foreign_key_check'), []);
    assert.equal((upgraded.pragma('integrity_check') as any[])[0].integrity_check, 'ok');
  } finally {
    upgraded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v19 lifecycle alert references remain retryable after the delivery-state upgrade', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ratatoskr-lifecycle-alert-upgrade-'));
  const path = join(directory, 'v19.db');
  const legacy = new Database(path);
  try {
    legacy.pragma('foreign_keys = ON');
    legacy.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    for (const migration of migrations.filter((item) => item.id <= 19)) {
      legacy.exec(migration.sql);
      legacy.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(migration.id, migration.name);
    }
    legacy.prepare("INSERT INTO divisions (guild_id, division_key, display_name) VALUES ('guild', 'vanaheim', 'Vanaheim')").run();
    const setup = createScoutSetup(legacy, {
      guildId: 'guild', divisionId: 1, divisionKey: 'vanaheim', divisionDisplayName: 'Vanaheim',
      createdBy: 'organizer', signupChannelId: 'signups', resultsChannelId: 'results',
      operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    legacy.prepare(`INSERT INTO scout_lifecycle_cleanups
      (setup_id, action, status_before, reason, scheduled_start_at, deadline_at,
        processed_at, actor_user_id, alert_attempted_at, alert_reference)
      VALUES (?, 'cancelled', 'open', 'automatic_deadline', 2000, 12800,
        12800, 'ratatoskr', 12800, 'cleanup-reference')`).run(setup.id);
    legacy.prepare(`INSERT INTO scout_lifecycle_recovery_attempts (setup_id, last_attempted_at)
      VALUES (?, 12800)`).run(setup.id);
  } finally { legacy.close(); }

  try {
    const upgraded = openDatabase(path);
    try {
      assert.ok(upgraded.prepare('SELECT id FROM schema_migrations WHERE id = 20').get());
      assert.deepEqual(upgraded.prepare(`SELECT alert_reference, alert_delivered_at
        FROM scout_lifecycle_cleanups`).get(), {
        alert_reference: 'cleanup-reference', alert_delivered_at: null,
      });
      assert.deepEqual(upgraded.prepare(`SELECT alert_reference, alert_attempted_at, alert_delivered_at
        FROM scout_lifecycle_recovery_attempts`).get(), {
        alert_reference: null, alert_attempted_at: null, alert_delivered_at: null,
      });
    } finally { upgraded.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
