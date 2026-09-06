import type Database from 'better-sqlite3';
import type { ScoutGameHost } from '../types.js';
import { appendScoutEvent } from './scoutEvents.js';

type ScoutGameHostRow = {
  setup_id: number;
  game_number: 1 | 2;
  lobby_host_user_id: string;
  created_at: string;
  updated_at: string;
};

function toScoutGameHost(row: ScoutGameHostRow): ScoutGameHost {
  return {
    setupId: row.setup_id,
    gameNumber: row.game_number,
    lobbyHostUserId: row.lobby_host_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listScoutGameHosts(db: Database.Database, setupId: number): ScoutGameHost[] {
  const rows = db.prepare('SELECT * FROM scout_game_hosts WHERE setup_id = ? ORDER BY game_number')
    .all(setupId) as ScoutGameHostRow[];
  return rows.map(toScoutGameHost);
}

export function initializeScoutGameHosts(
  db: Database.Database,
  setupId: number,
  hosts: readonly { gameNumber: 1 | 2; userId: string }[],
): boolean {
  return db.transaction(() => {
    const setup = db.prepare('SELECT status, game_count FROM scout_setups WHERE id = ?')
      .get(setupId) as { status: string; game_count: 1 | 2 } | undefined;
    if (!setup || setup.status !== 'published' || hosts.length !== setup.game_count) return false;
    if (db.prepare('SELECT 1 FROM scout_game_hosts WHERE setup_id = ?').get(setupId)) return false;

    const games = new Set(hosts.map((host) => host.gameNumber));
    if (games.size !== setup.game_count) return false;
    for (let gameNumber = 1; gameNumber <= setup.game_count; gameNumber++) {
      if (!games.has(gameNumber as 1 | 2)) return false;
    }

    const rostered = db.prepare(
      'SELECT 1 FROM scout_roster_slots WHERE setup_id = ? AND game_number = ? AND user_id = ?',
    );
    if (hosts.some((host) => !rostered.get(setupId, host.gameNumber, host.userId))) return false;

    const insert = db.prepare(
      'INSERT INTO scout_game_hosts (setup_id, game_number, lobby_host_user_id) VALUES (?, ?, ?)',
    );
    for (const host of hosts) insert.run(setupId, host.gameNumber, host.userId);
    return true;
  })();
}

export type ChangeScoutGameHostOutcome = 'updated' | 'unchanged' | 'stale' | 'ineligible';

function claimPublishedSetupVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
): boolean {
  return db.prepare(
    `UPDATE scout_setups SET version = version + 1,
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND version = ? AND status = 'published'
       AND result_message_id IS NOT NULL AND signup_post_reconciled = 1
       AND NOT EXISTS (SELECT 1 FROM scout_completions WHERE setup_id = scout_setups.id)`,
  ).run(setupId, expectedVersion).changes === 1;
}

export function changeScoutGameHostIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
  gameNumber: 1 | 2,
  lobbyHostUserId: string,
  actorUserId: string,
): ChangeScoutGameHostOutcome {
  return db.transaction((): ChangeScoutGameHostOutcome => {
    const current = listScoutGameHosts(db, setupId).find((host) => host.gameNumber === gameNumber);
    if (!current) return 'stale';
    if (current.lobbyHostUserId === lobbyHostUserId) return 'unchanged';
    const eligible = db.prepare(
      `SELECT 1 FROM scout_roster_slots
       WHERE setup_id = ? AND game_number = ? AND user_id = ? AND replacement_needed = 0`,
    ).get(setupId, gameNumber, lobbyHostUserId);
    if (!eligible) return 'ineligible';
    if (!claimPublishedSetupVersion(db, setupId, expectedVersion)) return 'stale';
    db.prepare(
      `UPDATE scout_game_hosts SET lobby_host_user_id = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE setup_id = ? AND game_number = ?`,
    ).run(lobbyHostUserId, setupId, gameNumber);
    appendScoutEvent(db, {
      setupId,
      setupVersion: expectedVersion + 1,
      eventType: 'lobby_host_changed',
      actorUserId,
      payload: { gameNumber, previousUserId: current.lobbyHostUserId, lobbyHostUserId },
    });
    return 'updated';
  })();
}

export function reassignScoutGameHostIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
  gameNumber: 1 | 2,
  excludedUserId: string,
  actorUserId: string | null,
  random: () => number = Math.random,
): ChangeScoutGameHostOutcome {
  return db.transaction((): ChangeScoutGameHostOutcome => {
    const current = listScoutGameHosts(db, setupId).find((host) => host.gameNumber === gameNumber);
    if (!current || current.lobbyHostUserId !== excludedUserId) return 'unchanged';
    const candidates = db.prepare(
      `SELECT user_id FROM scout_roster_slots
       WHERE setup_id = ? AND game_number = ? AND user_id <> ? AND replacement_needed = 0
       ORDER BY id`,
    ).all(setupId, gameNumber, excludedUserId) as { user_id: string }[];
    if (candidates.length === 0) return 'ineligible';
    if (!claimPublishedSetupVersion(db, setupId, expectedVersion)) return 'stale';
    const index = Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)));
    const lobbyHostUserId = candidates[index]!.user_id;
    db.prepare(
      `UPDATE scout_game_hosts SET lobby_host_user_id = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE setup_id = ? AND game_number = ? AND lobby_host_user_id = ?`,
    ).run(lobbyHostUserId, setupId, gameNumber, excludedUserId);
    appendScoutEvent(db, {
      setupId,
      setupVersion: expectedVersion + 1,
      eventType: 'lobby_host_reassigned',
      actorUserId,
      payload: { gameNumber, previousUserId: excludedUserId, lobbyHostUserId },
    });
    return 'updated';
  })();
}
