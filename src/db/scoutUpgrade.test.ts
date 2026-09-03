import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrations } from './migrations.js';
import { openDatabase } from './client.js';

test('v14 disk upgrade preserves active, pending and historical Scout routing and rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ratatoskr-upgrade-'));
  const path = join(directory, 'v14.db');
  const legacy = new Database(path);
  const tables = ['divisions', 'scout_setups', 'scout_signups', 'scout_roster_slots'];
  let snapshot: unknown[];
  try {
    legacy.pragma('foreign_keys = ON');
    legacy.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    for (const migration of migrations.filter((item) => item.id <= 14)) {
      legacy.exec(migration.sql);
      legacy.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(migration.id, migration.name);
    }
    legacy.prepare("INSERT INTO divisions (guild_id, division_key, display_name) VALUES ('guild', 'vanaheim', 'Vanaheim')").run();
    const states = ['posting', 'open', 'roster_ready', 'published', 'published', 'cancelled'];
    for (const [index, status] of states.entries()) {
      const id = index + 1;
      legacy.prepare(`INSERT INTO scout_setups (
        id, guild_id, division_id, division_key, division_display_name, created_by,
        signup_channel_id, results_channel_id, operations_channel_id, division_role_id,
        solo_emoji_id, jungle_emoji_id, mid_emoji_id, support_emoji_id, carry_emoji_id,
        start_at, role_limit, status, signup_message_id, result_message_id, signup_post_reconciled
      ) VALUES (?, 'guild', 1, 'vanaheim', 'Vanaheim', 'staff', 'signups', 'legacy-rosters', 'ops', 'division',
        'solo', 'jungle', 'mid', 'support', 'carry', 2000000000, 2, ?, ?, ?, ?)`)
        .run(id, status, status === 'posting' ? null : `signup-${id}`, index === 4 ? 'old-roster-message' : null, index === 4 ? 1 : 0);
      legacy.prepare("INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, 'player', 'solo')").run(id);
      if (['roster_ready', 'published'].includes(status)) {
        legacy.prepare("INSERT INTO scout_roster_slots (setup_id, game_number, team, role, user_id) VALUES (?, 1, 'team_one', 'solo', 'player')").run(id);
      }
    }
    snapshot = tables.map((table) => legacy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  } finally { legacy.close(); }
  const upgraded = openDatabase(path);
  try {
    assert.deepEqual(tables.map((table) => upgraded.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), snapshot);
    assert.deepEqual(upgraded.prepare('SELECT * FROM scout_roster_updates').all(), []);
    assert.ok(upgraded.prepare('SELECT id FROM schema_migrations WHERE id = 15').get());
    assert.deepEqual(upgraded.pragma('foreign_key_check'), []);
    assert.equal((upgraded.pragma('integrity_check') as any[])[0].integrity_check, 'ok');
  } finally {
    upgraded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
