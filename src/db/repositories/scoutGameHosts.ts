import type Database from 'better-sqlite3';
import type { ScoutGameHost } from '../types.js';

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
