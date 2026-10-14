import type Database from 'better-sqlite3';
import type { Client, GuildMember, PartialGuildMember, PartialUser, Role, User } from 'discord.js';
import { observeFullGuildInventory, observeInventoryMember, observeInventoryDeparture,
  observeInventoryRole, observeInventoryRoleDeletion } from '../db/repositories/guildRoleInventory.js';
import { listenToCompleteLeagueMembers } from './leagueMemberReads.js';

/** Observes Discord only. It never grants roles, changes league records, calls
 * Sheets, or adds a member fetch. Existing startup/daily reads supply catch-up. */
export function installGuildRoleInventory(client: Client, db: Database.Database, guildId: string): () => void {
  const safely = (work: () => void) => {
    try { work(); } catch { console.error('Server role inventory observation failed; next complete read can recover it.'); }
  };
  const at = () => new Date().toISOString();
  const member = (value: GuildMember) => {
    if (value.guild.id !== guildId || value.partial) return;
    safely(() => observeInventoryMember(db, guildId, { discordId: value.id, displayName: value.displayName,
      bot: value.user.bot, roleIds: [...value.roles.cache.keys()] }, at()));
  };
  const update = (_old: GuildMember | PartialGuildMember, value: GuildMember) => member(value);
  const departure = (value: GuildMember | PartialGuildMember) => {
    if (value.guild.id === guildId) safely(() => observeInventoryDeparture(db, guildId, { discordId: value.id,
      displayName: typeof value.displayName === 'string' ? value.displayName : undefined,
      bot: typeof value.user?.bot === 'boolean' ? value.user.bot : undefined }, at()));
  };
  const role = (value: Role) => {
    if (value.guild.id === guildId) safely(() => observeInventoryRole(db, guildId, value, at()));
  };
  const roleUpdate = (_old: Role, value: Role) => role(value);
  const roleDelete = (value: Role) => {
    if (value.guild.id === guildId) safely(() => observeInventoryRoleDeletion(db, guildId, value.id, at()));
  };
  const userUpdate = (_old: User | PartialUser, value: User) => {
    const cached = client.guilds?.cache.get(guildId)?.members.cache.get(value.id);
    if (cached) member(cached);
  };
  const stopFull = listenToCompleteLeagueMembers(client, (guild, members) => {
    if (guild.id === guildId) safely(() => observeFullGuildInventory(db, guildId, members,
      guild.roles.cache.map(value => ({ id: value.id, name: value.name })), at()));
  });
  client.on('guildMemberAdd', member); client.on('guildMemberUpdate', update); client.on('guildMemberRemove', departure);
  client.on('roleCreate', role); client.on('roleUpdate', roleUpdate); client.on('roleDelete', roleDelete); client.on('userUpdate', userUpdate);
  return () => {
    stopFull();
    client.off('guildMemberAdd', member); client.off('guildMemberUpdate', update); client.off('guildMemberRemove', departure);
    client.off('roleCreate', role); client.off('roleUpdate', roleUpdate); client.off('roleDelete', roleDelete); client.off('userUpdate', userUpdate);
  };
}
