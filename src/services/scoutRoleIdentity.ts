import type Database from 'better-sqlite3';
import type { Guild } from 'discord.js';
import { getActiveManagedResourceByLogicalKey } from '../db/index.js';
import { serverRoleLogicalKey } from './serverBootstrap.js';

export const FRANCHISE_REPRESENTATIVE_ROLE = 'Franchise Representative';
export const FRANCHISE_REPRESENTATIVE_KEY = serverRoleLogicalKey('franchise_representative');

/** Managed identity wins over names, including after a Discord rename. */
export function resolveFranchiseRepresentativeId(db: Database.Database, guild: Guild): string | null {
  const managed = getActiveManagedResourceByLogicalKey(db, guild.id, FRANCHISE_REPRESENTATIVE_KEY);
  if (managed) return guild.roles.cache.has(managed.discordResourceId) ? managed.discordResourceId : null;
  const matches = guild.roles.cache.filter((role) => role.name === FRANCHISE_REPRESENTATIVE_ROLE);
  if (matches.size > 1) throw new Error('Franchise Representative role is ambiguous. Run server bootstrap after resolving duplicate roles.');
  return matches.first()?.id ?? null;
}
