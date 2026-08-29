import {
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type Role,
  type TextChannel,
  type VoiceChannel,
} from 'discord.js';
import type Database from 'better-sqlite3';
import { yslGuildStructure, type GuildChannelSpec, type GuildRoleSpec } from '../config/guild-structure.js';
import {
  getActiveManagedResourceByLogicalKey,
  insertManagedResource,
  listManagedResourcesByDomain,
  markManagedResourceObsolete,
  type ManagedResource,
} from '../db/index.js';
import { STAFF_ROLES } from './divisions.js';
import {
  classifyMatch,
  currentServerLogicalKeys,
  detectObsoleteManagedResources,
  resolveChannelPermissionOverwrites,
  serverCategoryLogicalKey,
  serverChannelLogicalKey,
  serverRoleLogicalKey,
  type CandidateResource,
} from './serverBootstrap.js';

export type ServerBootstrapOptions = {
  apply: boolean;
  deleteObsolete: boolean;
};

// Shared orchestration for Server Bootstrap v2 (#16): the ensure-or-adopt
// and cleanup logic, extracted so both the standalone script
// (scripts/bootstrap-guild.ts) and the /server bootstrap command (#25) run
// exactly the same code against a live Guild -- one source of truth,
// parameterized by a log callback and options instead of process.argv and
// console.log so either caller can drive it. Only the exact-match/
// ambiguous/no-match cases from #16 ever result in a Discord create or an
// adopt-registration; ambiguity always means "leave it alone" -- for roles
// that means aborting outright (many overwrites below depend on knowing
// exactly which role id to use), for categories/channels it means skipping
// just that one resource and continuing the run.
export async function runServerBootstrap(
  db: Database.Database,
  guild: Guild,
  options: ServerBootstrapOptions,
  log: (line: string) => void,
): Promise<void> {
  const { apply, deleteObsolete } = options;

  function logAction(action: string, detail: string) {
    log(`${apply ? '[APPLY]' : '[DRY-RUN]'} ${action}: ${detail}`);
  }

  async function resolveManagedRole(logicalKey: string): Promise<Role | undefined> {
    const managed = getActiveManagedResourceByLogicalKey(db, guild.id, logicalKey);
    if (!managed) return undefined;

    const resolved = guild.roles.cache.get(managed.discordResourceId);
    if (resolved) return resolved;

    logAction('stale managed role', `${logicalKey} pointed at a role that no longer exists; re-evaluating`);
    if (apply) markManagedResourceObsolete(db, managed.id);
    return undefined;
  }

  async function ensureRole(spec: GuildRoleSpec): Promise<Role> {
    const logicalKey = serverRoleLogicalKey(spec.key);

    const managedRole = await resolveManagedRole(logicalKey);
    if (managedRole) {
      logAction('role managed', spec.name);
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
      logAction('role exists (adopting)', spec.name);
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

    logAction('create role', spec.name);
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

  function resolveAccessOverwrites(roleMap: Map<string, Role>, access?: string[]) {
    if (!access) return undefined;

    return [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      ...access.map((roleName) => {
        const role = roleMap.get(roleName);
        if (!role) throw new Error(`Missing configured role: ${roleName}`);
        return { id: role.id, allow: [PermissionFlagsBits.ViewChannel] };
      }),
    ];
  }

  function resolveChannelOverwrites(roleMap: Map<string, Role>, spec: GuildChannelSpec) {
    return resolveChannelPermissionOverwrites(
      guild.roles.everyone.id,
      (roleName) => roleMap.get(roleName)?.id,
      STAFF_ROLES,
      spec,
    );
  }

  async function ensureCategory(
    roleMap: Map<string, Role>,
    spec: (typeof yslGuildStructure.categories)[number],
  ): Promise<CategoryChannel | null> {
    const logicalKey = serverCategoryLogicalKey(spec.key);
    const permissionOverwrites = resolveAccessOverwrites(roleMap, spec.access);

    const managed = getActiveManagedResourceByLogicalKey(db, guild.id, logicalKey);
    if (managed) {
      const resolved = guild.channels.cache.get(managed.discordResourceId);
      if (resolved && resolved.type === ChannelType.GuildCategory) {
        logAction('category managed', spec.name);
        if (permissionOverwrites && apply) {
          await resolved.permissionOverwrites.set(permissionOverwrites, 'Ratatoskr bootstrap permission reconciliation');
        }
        return resolved;
      }
      logAction('stale managed category', `${logicalKey} pointed at a category that no longer exists; re-evaluating`);
      if (apply) markManagedResourceObsolete(db, managed.id);
    }

    const candidates: CandidateResource[] = guild.channels.cache
      .filter((channel) => channel.type === ChannelType.GuildCategory)
      .map((channel) => ({ discordId: channel.id, name: channel.name, kind: 'category', parentId: null }));
    const match = classifyMatch(candidates, { name: spec.name, kind: 'category', parentId: null });

    if (match.outcome === 'ambiguous') {
      logAction(
        'category ambiguous',
        `${spec.name}: ${match.candidates.length} candidates found, none adopted. Resolve manually; skipping this category and its channels this run.`,
      );
      return null;
    }

    if (match.outcome === 'exact') {
      logAction('category exists (adopting)', spec.name);
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

    logAction('create category', spec.name);
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
    roleMap: Map<string, Role>,
    category: CategoryChannel,
    categorySpec: (typeof yslGuildStructure.categories)[number],
    spec: GuildChannelSpec,
  ) {
    const categoryName = categorySpec.name;
    const parentId = category.id;
    const expectedType = spec.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
    const resourceType = spec.type === 'voice' ? ('voice_channel' as const) : ('text_channel' as const);
    const logicalKey = serverChannelLogicalKey(categorySpec.key, spec.key, resourceType);
    const permissionOverwrites = resolveChannelOverwrites(roleMap, spec);

    const managed = getActiveManagedResourceByLogicalKey(db, guild.id, logicalKey);
    if (managed) {
      const resolved = guild.channels.cache.get(managed.discordResourceId);
      if (resolved && resolved.type === expectedType) {
        logAction('channel managed', `${categoryName} / ${spec.name}`);
        if (permissionOverwrites && apply) {
          await (resolved as TextChannel | VoiceChannel).permissionOverwrites.set(
            permissionOverwrites,
            'Ratatoskr bootstrap permission reconciliation',
          );
        }
        return;
      }
      logAction('stale managed channel', `${logicalKey} pointed at a channel that no longer exists; re-evaluating`);
      if (apply) markManagedResourceObsolete(db, managed.id);
    }

    // Deliberately not filtered to this category's channels: a same-named
    // channel sitting under the wrong parent must still surface as a
    // candidate so classifyMatch can call it ambiguous (per #16's ownership
    // rules) rather than being invisible here and causing a duplicate create.
    const candidates: CandidateResource[] = guild.channels.cache
      .filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice)
      .map((channel) => ({
        discordId: channel.id,
        name: channel.name,
        kind: channel.type === ChannelType.GuildVoice ? 'voice_channel' : 'text_channel',
        parentId: channel.parentId,
      }));
    const match = classifyMatch(candidates, { name: spec.name, kind: resourceType, parentId });

    if (match.outcome === 'ambiguous') {
      logAction(
        'channel ambiguous',
        `${categoryName} / ${spec.name}: ${match.candidates.length} candidates found, none adopted. Resolve manually; skipping this channel this run.`,
      );
      return;
    }

    if (match.outcome === 'exact') {
      logAction('channel exists (adopting)', `${categoryName} / ${spec.name}`);
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

    logAction('create channel', `${categoryName} / ${spec.name}`);
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

  function describeObsolete(resource: ManagedResource): string {
    const current =
      resource.resourceType === 'role'
        ? guild.roles.cache.get(resource.discordResourceId)?.name
        : guild.channels.cache.get(resource.discordResourceId)?.name;
    return `${resource.logicalKey} (${resource.resourceType}, discord id ${resource.discordResourceId}${current ? `, currently named "${current}"` : ', not found in Discord anymore'})`;
  }

  async function runCleanup() {
    const managed = listManagedResourcesByDomain(db, guild.id, 'server', 'active');
    const currentKeys = currentServerLogicalKeys(yslGuildStructure);
    const obsolete = detectObsoleteManagedResources(managed, currentKeys);

    log('\n--- Cleanup preview ---');
    if (obsolete.length === 0) {
      log('No obsolete managed resources found.');
      return;
    }

    for (const resource of obsolete) {
      log(`  - ${describeObsolete(resource)}`);
    }

    if (!deleteObsolete) {
      log(
        '\nKeep Existing (default): the resources above were left untouched. ' +
          'Re-run with --apply --delete-obsolete to remove exactly this set.',
      );
      return;
    }

    if (!apply) {
      log('\n--delete-obsolete requires --apply too; nothing was deleted in dry-run mode.');
      return;
    }

    log('\nDelete Obsolete: attempting to delete exactly the set previewed above.');
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

    log(`\nDeleted (${succeeded.length}):`);
    for (const resource of succeeded) log(`  - ${describeObsolete(resource)}`);

    if (failed.length > 0) {
      log(`\nFAILED to delete (${failed.length}) -- still active/managed, safe to retry:`);
      for (const { resource, error } of failed) log(`  - ${describeObsolete(resource)}: ${error}`);
    }
  }

  await guild.roles.fetch();
  await guild.channels.fetch();

  log(`\nTarget guild: ${guild.name} (${guild.id})`);
  log(apply ? 'MODE: APPLY — changes will be created/reconciled.' : 'MODE: DRY RUN — no Discord changes will be made.');
  log('Existing unmatched roles/channels are preserved; restricted matching content is permission-reconciled.\n');

  const roleMap = new Map<string, Role>();
  for (const roleSpec of yslGuildStructure.roles) {
    roleMap.set(roleSpec.name, await ensureRole(roleSpec));
  }

  for (const categorySpec of yslGuildStructure.categories) {
    const category = await ensureCategory(roleMap, categorySpec);
    if (!category) continue;
    for (const channelSpec of categorySpec.channels) {
      await ensureChannel(roleMap, category, categorySpec, channelSpec);
    }
  }

  // runCleanup itself gates actual deletion behind apply/deleteObsolete --
  // the preview (which resources are obsolete) is safe and useful to show
  // in dry-run mode too, especially once a prior apply run has already
  // populated managed_resources.
  await runCleanup();

  log('\nBootstrap complete.');
  if (!apply) log('Review the plan above, then rerun with --apply when ready.');
}
