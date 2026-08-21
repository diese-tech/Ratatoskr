import 'dotenv/config';
import type Database from 'better-sqlite3';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type Role,
  type TextChannel,
  type VoiceChannel,
} from 'discord.js';
import { env } from '../src/config/env.js';
import { yslGuildStructure, type GuildChannelSpec, type GuildRoleSpec } from '../src/config/guild-structure.js';
import {
  closeDatabase,
  getActiveManagedResourceByLogicalKey,
  insertManagedResource,
  listManagedResourcesByDomain,
  markManagedResourceObsolete,
  openDatabase,
  type ManagedResource,
} from '../src/db/index.js';
import { STAFF_ROLES } from '../src/services/divisions.js';
import {
  classifyMatch,
  currentServerLogicalKeys,
  detectObsoleteManagedResources,
  resolveChannelPermissionOverwrites,
  serverCategoryLogicalKey,
  serverChannelLogicalKey,
  serverRoleLogicalKey,
  type CandidateResource,
} from '../src/services/serverBootstrap.js';

const apply = process.argv.includes('--apply');
const deleteObsolete = process.argv.includes('--delete-obsolete');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function log(action: string, detail: string) {
  console.log(`${apply ? '[APPLY]' : '[DRY-RUN]'} ${action}: ${detail}`);
}

// Only the exact-match/ambiguous/no-match cases from #16 ever result in a
// Discord create or an adopt-registration. Ambiguity always means "leave it
// alone" -- for roles that means aborting outright (many overwrites below
// depend on knowing exactly which role id to use), for categories/channels
// it means skipping just that one resource and continuing the run.

async function resolveManagedRole(
  db: Database.Database,
  guild: Guild,
  logicalKey: string,
): Promise<Role | undefined> {
  const managed = getActiveManagedResourceByLogicalKey(db, guild.id, logicalKey);
  if (!managed) return undefined;

  const resolved = guild.roles.cache.get(managed.discordResourceId);
  if (resolved) return resolved;

  log('stale managed role', `${logicalKey} pointed at a role that no longer exists; re-evaluating`);
  if (apply) markManagedResourceObsolete(db, managed.id);
  return undefined;
}

async function ensureRole(db: Database.Database, guild: Guild, spec: GuildRoleSpec): Promise<Role> {
  const logicalKey = serverRoleLogicalKey(spec.name);

  const managedRole = await resolveManagedRole(db, guild, logicalKey);
  if (managedRole) {
    log('role managed', spec.name);
    return managedRole;
  }

  const candidates: CandidateResource[] = guild.roles.cache.map((role) => ({
    discordId: role.id,
    name: role.name,
    kind: 'role',
    parentId: null,
  }));
  const match = classifyMatch(candidates, { name: spec.name, kind: 'role', parentId: null });

  if (match.outcome === 'ambiguous') {
    throw new Error(
      `Role "${spec.name}" is ambiguous: ${match.candidates.length} roles share that name in this guild. ` +
        'Resolve manually (rename or remove duplicates) before running bootstrap.',
    );
  }

  if (match.outcome === 'exact') {
    log('role exists (adopting)', spec.name);
    const role = guild.roles.cache.get(match.candidate.discordId)!;
    if (apply) {
      insertManagedResource(db, {
        discordResourceId: role.id,
        guildId: guild.id,
        resourceType: 'role',
        logicalKey,
        scaffoldDomain: 'server',
      });
    }
    return role;
  }

  log('create role', spec.name);
  if (!apply) {
    return { id: `dry-role:${spec.name}`, name: spec.name } as Role;
  }

  const role = await guild.roles.create({
    name: spec.name,
    hoist: spec.hoist ?? false,
    mentionable: spec.mentionable ?? false,
    colors: spec.color ? { primaryColor: spec.color } : undefined,
    reason: 'Ratatoskr YSL guild bootstrap',
  });
  insertManagedResource(db, {
    discordResourceId: role.id,
    guildId: guild.id,
    resourceType: 'role',
    logicalKey,
    scaffoldDomain: 'server',
  });
  return role;
}

function resolveAccessOverwrites(guild: Guild, roleMap: Map<string, Role>, access?: string[]) {
  if (!access) return undefined;

  return [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    ...access.map((roleName) => {
      const role = roleMap.get(roleName);
      if (!role) throw new Error(`Missing configured role: ${roleName}`);
      return {
        id: role.id,
        allow: [PermissionFlagsBits.ViewChannel],
      };
    }),
  ];
}

function resolveChannelOverwrites(guild: Guild, roleMap: Map<string, Role>, spec: GuildChannelSpec) {
  return resolveChannelPermissionOverwrites(guild.roles.everyone.id, (roleName) => roleMap.get(roleName)?.id, STAFF_ROLES, spec);
}

async function ensureCategory(
  db: Database.Database,
  guild: Guild,
  roleMap: Map<string, Role>,
  spec: (typeof yslGuildStructure.categories)[number],
): Promise<CategoryChannel | null> {
  const logicalKey = serverCategoryLogicalKey(spec.name);
  const permissionOverwrites = resolveAccessOverwrites(guild, roleMap, spec.access);

  const managed = getActiveManagedResourceByLogicalKey(db, guild.id, logicalKey);
  if (managed) {
    const resolved = guild.channels.cache.get(managed.discordResourceId);
    if (resolved && resolved.type === ChannelType.GuildCategory) {
      log('category managed', spec.name);
      if (permissionOverwrites && apply) {
        await resolved.permissionOverwrites.set(permissionOverwrites, 'Ratatoskr bootstrap permission reconciliation');
      }
      return resolved;
    }
    log('stale managed category', `${logicalKey} pointed at a category that no longer exists; re-evaluating`);
    if (apply) markManagedResourceObsolete(db, managed.id);
  }

  const candidates: CandidateResource[] = guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildCategory)
    .map((channel) => ({ discordId: channel.id, name: channel.name, kind: 'category', parentId: null }));
  const match = classifyMatch(candidates, { name: spec.name, kind: 'category', parentId: null });

  if (match.outcome === 'ambiguous') {
    log(
      'category ambiguous',
      `${spec.name}: ${match.candidates.length} candidates found, none adopted. Resolve manually; skipping this category and its channels this run.`,
    );
    return null;
  }

  if (match.outcome === 'exact') {
    log('category exists (adopting)', spec.name);
    const category = guild.channels.cache.get(match.candidate.discordId) as CategoryChannel;
    if (apply) {
      insertManagedResource(db, {
        discordResourceId: category.id,
        guildId: guild.id,
        resourceType: 'category',
        logicalKey,
        scaffoldDomain: 'server',
      });
      if (permissionOverwrites) {
        await category.permissionOverwrites.set(permissionOverwrites, 'Ratatoskr bootstrap permission reconciliation');
      }
    }
    return category;
  }

  log('create category', spec.name);
  if (!apply) {
    return { id: `dry-category:${spec.name}`, name: spec.name } as CategoryChannel;
  }

  const category = (await guild.channels.create({
    name: spec.name,
    type: ChannelType.GuildCategory,
    permissionOverwrites,
    reason: 'Ratatoskr YSL guild bootstrap',
  })) as CategoryChannel;
  insertManagedResource(db, {
    discordResourceId: category.id,
    guildId: guild.id,
    resourceType: 'category',
    logicalKey,
    scaffoldDomain: 'server',
  });
  return category;
}

async function ensureChannel(
  db: Database.Database,
  guild: Guild,
  roleMap: Map<string, Role>,
  category: CategoryChannel,
  categoryName: string,
  spec: GuildChannelSpec,
) {
  const parentId = category.id;
  const expectedType = spec.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
  const resourceType = spec.type === 'voice' ? ('voice_channel' as const) : ('text_channel' as const);
  const logicalKey = serverChannelLogicalKey(categoryName, spec.name, resourceType);
  const permissionOverwrites = resolveChannelOverwrites(guild, roleMap, spec);

  const managed = getActiveManagedResourceByLogicalKey(db, guild.id, logicalKey);
  if (managed) {
    const resolved = guild.channels.cache.get(managed.discordResourceId);
    if (resolved && resolved.type === expectedType) {
      log('channel managed', `${categoryName} / ${spec.name}`);
      if (permissionOverwrites && apply) {
        await (resolved as TextChannel | VoiceChannel).permissionOverwrites.set(
          permissionOverwrites,
          'Ratatoskr bootstrap permission reconciliation',
        );
      }
      return;
    }
    log('stale managed channel', `${logicalKey} pointed at a channel that no longer exists; re-evaluating`);
    if (apply) markManagedResourceObsolete(db, managed.id);
  }

  const candidates: CandidateResource[] = guild.channels.cache
    .filter((channel) => channel.parentId === parentId)
    .map((channel) => ({
      discordId: channel.id,
      name: channel.name,
      kind: channel.type === ChannelType.GuildVoice ? 'voice_channel' : 'text_channel',
      parentId: channel.parentId,
    }));
  const match = classifyMatch(candidates, { name: spec.name, kind: resourceType, parentId });

  if (match.outcome === 'ambiguous') {
    log(
      'channel ambiguous',
      `${categoryName} / ${spec.name}: ${match.candidates.length} candidates found, none adopted. Resolve manually; skipping this channel this run.`,
    );
    return;
  }

  if (match.outcome === 'exact') {
    log('channel exists (adopting)', `${categoryName} / ${spec.name}`);
    const channel = guild.channels.cache.get(match.candidate.discordId) as TextChannel | VoiceChannel;
    if (apply) {
      insertManagedResource(db, {
        discordResourceId: channel.id,
        guildId: guild.id,
        resourceType,
        logicalKey,
        parentResourceId: parentId,
        scaffoldDomain: 'server',
      });
      if (permissionOverwrites) {
        await channel.permissionOverwrites.set(permissionOverwrites, 'Ratatoskr bootstrap permission reconciliation');
      }
    }
    return;
  }

  log('create channel', `${categoryName} / ${spec.name}`);
  if (!apply) return;

  const channel = await guild.channels.create({
    name: spec.name,
    type: expectedType,
    parent: parentId,
    topic: spec.type === 'text' ? spec.topic : undefined,
    permissionOverwrites,
    reason: 'Ratatoskr YSL guild bootstrap',
  });
  insertManagedResource(db, {
    discordResourceId: channel.id,
    guildId: guild.id,
    resourceType,
    logicalKey,
    parentResourceId: parentId,
    scaffoldDomain: 'server',
  });
}

function describeObsolete(guild: Guild, resource: ManagedResource): string {
  const current =
    resource.resourceType === 'role'
      ? guild.roles.cache.get(resource.discordResourceId)?.name
      : guild.channels.cache.get(resource.discordResourceId)?.name;
  return `${resource.logicalKey} (${resource.resourceType}, discord id ${resource.discordResourceId}${current ? `, currently named "${current}"` : ', not found in Discord anymore'})`;
}

async function runCleanup(db: Database.Database, guild: Guild) {
  const managed = listManagedResourcesByDomain(db, guild.id, 'server', 'active');
  const currentKeys = currentServerLogicalKeys(yslGuildStructure);
  const obsolete = detectObsoleteManagedResources(managed, currentKeys);

  console.log('\n--- Cleanup preview ---');
  if (obsolete.length === 0) {
    console.log('No obsolete managed resources found.');
    return;
  }

  for (const resource of obsolete) {
    console.log(`  - ${describeObsolete(guild, resource)}`);
  }

  if (!deleteObsolete) {
    console.log(
      '\nKeep Existing (default): the resources above were left untouched. ' +
        'Re-run with --apply --delete-obsolete to remove exactly this set.',
    );
    return;
  }

  if (!apply) {
    console.log('\n--delete-obsolete requires --apply too; nothing was deleted in dry-run mode.');
    return;
  }

  console.log('\nDelete Obsolete: attempting to delete exactly the set previewed above.');
  const succeeded: ManagedResource[] = [];
  const failed: { resource: ManagedResource; error: string }[] = [];

  for (const resource of obsolete) {
    try {
      if (resource.resourceType === 'role') {
        const role = guild.roles.cache.get(resource.discordResourceId);
        if (role) await role.delete('Ratatoskr server bootstrap cleanup');
      } else {
        const channel = guild.channels.cache.get(resource.discordResourceId);
        if (channel) await channel.delete('Ratatoskr server bootstrap cleanup');
      }
      markManagedResourceObsolete(db, resource.id);
      succeeded.push(resource);
    } catch (error) {
      failed.push({ resource, error: (error as Error).message });
    }
  }

  console.log(`\nDeleted (${succeeded.length}):`);
  for (const resource of succeeded) console.log(`  - ${describeObsolete(guild, resource)}`);

  if (failed.length > 0) {
    console.log(`\nFAILED to delete (${failed.length}) -- still active/managed, safe to retry:`);
    for (const { resource, error } of failed) console.log(`  - ${describeObsolete(guild, resource)}: ${error}`);
  }
}

async function bootstrap() {
  const db = openDatabase();

  try {
    await client.login(env.DISCORD_TOKEN);
    const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
    await guild.roles.fetch();
    await guild.channels.fetch();

    console.log(`\nTarget guild: ${guild.name} (${guild.id})`);
    console.log(apply ? 'MODE: APPLY — changes will be created/reconciled.' : 'MODE: DRY RUN — no Discord changes will be made.');
    console.log('Existing unmatched roles/channels are preserved; restricted matching content is permission-reconciled.\n');

    const roleMap = new Map<string, Role>();
    for (const roleSpec of yslGuildStructure.roles) {
      roleMap.set(roleSpec.name, await ensureRole(db, guild, roleSpec));
    }

    for (const categorySpec of yslGuildStructure.categories) {
      const category = await ensureCategory(db, guild, roleMap, categorySpec);
      if (!category) continue;
      for (const channelSpec of categorySpec.channels) {
        await ensureChannel(db, guild, roleMap, category, categorySpec.name, channelSpec);
      }
    }

    if (apply) {
      await runCleanup(db, guild);
    } else {
      console.log('\n--- Cleanup preview ---');
      console.log('Skipped in dry-run: managed-resource registrations only happen with --apply, so a dry run has nothing to compare yet.');
    }

    console.log('\nBootstrap complete.');
    if (!apply) console.log('Review the plan above, then rerun with --apply when ready.');
  } finally {
    closeDatabase(db);
    await client.destroy();
  }
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
