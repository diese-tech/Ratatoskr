import type Database from 'better-sqlite3';
import type { Guild } from 'discord.js';
import { listDivisions } from '../db/index.js';

/** Eligibility already fetched these members. Balancing consumes that same
 * observation, so it adds no Sheets calls or full-member/targeted fetch loop.
 */
export function inhouseDivisionHints(db: Database.Database, guild: Guild,
  userIds: Iterable<string>): Map<string, string> {
  const divisions = listDivisions(db, guild.id).filter(d => d.status === 'active' && d.roleId);
  const result = new Map<string, string>();
  for (const id of userIds) {
    const member = guild.members.cache?.get(id);
    const matches = divisions.filter(d => member?.roles.cache.has(d.roleId!));
    if (matches.length === 1) result.set(id, matches[0]!.divisionKey);
  }
  return result;
}
