import {
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type GuildMember,
  type Role,
  type TextChannel,
  type VoiceChannel,
} from 'discord.js';
import type Database from 'better-sqlite3';
import { divisions, DIVISION_ROLE_COLORS, type DivisionKey, type DivisionSpec } from '../config/guild-structure.js';
import type { ManagedResourceType } from '../db/types.js';
import {
  getActiveManagedResourceByLogicalKey,
  getDivisionByKey,
  getScoutConfig,
  insertManagedResource,
  markManagedResourceObsolete,
  setManagedResourceParent,
  setDivisionStatus,
  upsertDivision,
} from '../db/index.js';
import {
  divisionCaptainRoleLogicalKey,
  divisionCategoryLogicalKey,
  divisionChannelLogicalKey,
  divisionManagerRoleLogicalKey,
  divisionRoleLogicalKey,
  assertNoDuplicateKeys,
} from './divisionScaffold.js';
import { classifyMatch, type CandidateResource } from './serverBootstrap.js';

export const STAFF_ROLES = ['Valkyries', 'Aesir', 'Allfather'] as const;
export const DIVISION_ADMIN_ROLES = ['Aesir', 'Allfather'] as const;
export const FRANCHISE_REPRESENTATIVE_ROLE = 'Franchise Representative';

export type DivisionPermissionProfile =
  | 'category'
  | 'captain_only'
  | 'announcements'
  | 'captain_work'
  | 'scout_signups'
  | 'scout_results';

export type DivisionPermissionRoleIds = {
  everyone: string;
  division: string;
  manager: string;
  captain: string;
  franchiseRepresentative: string;
  admins: readonly string[];
};

export type DivisionPermissionOverwrite = {
  id: string;
  allow: bigint[];
  deny: bigint[];
};

const DIVISION_POST_PERMISSIONS = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.SendVoiceMessages,
  PermissionFlagsBits.SendPolls,
];

export function resolveDivisionPermissionOverwrites(
  roleIds: DivisionPermissionRoleIds,
  profile: DivisionPermissionProfile,
): DivisionPermissionOverwrite[] {
  if (profile === 'category') {
    return [
      { id: roleIds.everyone, allow: [], deny: [PermissionFlagsBits.ViewChannel] },
      ...[
        roleIds.division,
        roleIds.manager,
        roleIds.captain,
        roleIds.franchiseRepresentative,
        ...roleIds.admins,
      ].map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel], deny: [] })),
    ];
  }

  if (profile === 'captain_only') {
    return [
      { id: roleIds.everyone, allow: [], deny: [PermissionFlagsBits.ViewChannel] },
      ...[roleIds.manager, roleIds.captain, ...roleIds.admins].map((id) => ({
        id,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [],
      })),
    ];
  }

  if (profile === 'announcements') {
    return [
      { id: roleIds.everyone, allow: [], deny: [PermissionFlagsBits.ViewChannel, ...DIVISION_POST_PERMISSIONS] },
      ...[roleIds.manager, ...roleIds.admins].map((id) => ({
        id,
        allow: [PermissionFlagsBits.ViewChannel, ...DIVISION_POST_PERMISSIONS],
        deny: [],
      })),
      ...[roleIds.division, roleIds.captain, roleIds.franchiseRepresentative].map((id) => ({
        id,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [],
      })),
    ];
  }

  if (profile === 'captain_work') {
    return [
      { id: roleIds.everyone, allow: [], deny: [PermissionFlagsBits.ViewChannel, ...DIVISION_POST_PERMISSIONS] },
      ...[roleIds.manager, roleIds.captain, ...roleIds.admins].map((id) => ({
        id,
        allow: [PermissionFlagsBits.ViewChannel, ...DIVISION_POST_PERMISSIONS],
        deny: [],
      })),
      ...[roleIds.division, roleIds.franchiseRepresentative].map((id) => ({
        id,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [],
      })),
    ];
  }

  if (profile === 'scout_signups') {
    return [
      { id: roleIds.everyone, allow: [], deny: [PermissionFlagsBits.ViewChannel, ...DIVISION_POST_PERMISSIONS] },
      ...[roleIds.manager, roleIds.captain, roleIds.franchiseRepresentative, ...roleIds.admins].map((id) => ({
        id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions, ...DIVISION_POST_PERMISSIONS],
        deny: [],
      })),
      { id: roleIds.division, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions], deny: [] },
    ];
  }

  if (profile === 'scout_results') {
    const restricted = [PermissionFlagsBits.ViewChannel, ...DIVISION_POST_PERMISSIONS, PermissionFlagsBits.AddReactions];
    return [
      { id: roleIds.everyone, allow: [], deny: restricted },
      ...[roleIds.manager, roleIds.captain, roleIds.franchiseRepresentative, ...roleIds.admins].map((id) => ({
        id,
        allow: [...restricted],
        deny: [],
      })),
      { id: roleIds.division, allow: [PermissionFlagsBits.ViewChannel], deny: [] },
    ];
  }

  return [];
}

export type DivisionProvisionResult = {
  division: string;
  created: string[];
  reused: string[];
  // True when this run found the division already archived -- provisioning
  // restores active-state permission overwrites unconditionally (see
  // upsertDivision's comment), so callers should tell the operator their
  // division is visible again, not silently leave them assuming it's still
  // hidden just because they didn't explicitly run an "unarchive" command.
  reactivatedFromArchived: boolean;
};

export function isDivisionKey(value: string): value is DivisionKey {
  return divisions.some((division) => division.key === value);
}

export function getDivisionSpec(key: DivisionKey): DivisionSpec {
  const division = divisions.find((candidate) => candidate.key === key);
  if (!division) throw new Error(`Unknown division key: ${key}`);
  return division;
}

export type DivisionChannelTemplateSpec = {
  // Stable identity, authored once -- see #31 Defect 1/Defect 2. Every
  // division shares this same template, so this key (combined with the
  // division's own key) is what makes a division channel's logical key
  // identity stable across a config-side rename of the *division's* display
  // name (which changes the channel's Discord name/slug, but never its key).
  key: string;
  type: 'text' | 'voice';
  // Presentational suffix: text channels become `${slug}-${suffix}`, voice
  // channels become `${division.name} ${suffix}` (Discord's usual Title Case
  // for voice channel names) -- see channelName() below.
  suffix: string;
  permissionProfile?: Exclude<DivisionPermissionProfile, 'category'>;
  // Existing YSL divisions predate the division-prefix convention for text
  // channels. This is an adoption-only alias: new channels use the
  // configured prefixed name, while exactly one matching legacy channel in
  // the expected category may be registered under the stable authored key.
  legacyName?: string;
};

// Ordered so a division's channel list reads top-to-bottom the way staff
// actually use it: captain coordination first, then the information
// channels, then voice last.
export const DIVISION_CHANNEL_TEMPLATE: readonly DivisionChannelTemplateSpec[] = [
  { key: 'captain_chat', type: 'text', suffix: 'captain-chat', legacyName: 'captain-chat', permissionProfile: 'captain_only' },
  { key: 'announcements', type: 'text', suffix: 'announcements', legacyName: 'announcements', permissionProfile: 'announcements' },
  { key: 'general', type: 'text', suffix: 'general', legacyName: 'general' },
  { key: 'tier_list', type: 'text', suffix: 'tier-list', legacyName: 'tier-list' },
  { key: 'scheduling', type: 'text', suffix: 'scheduling', legacyName: 'scheduling', permissionProfile: 'captain_work' },
  { key: 'match_reports', type: 'text', suffix: 'match-reports', legacyName: 'match-reports', permissionProfile: 'captain_work' },
  { key: 'scout_signups', type: 'text', suffix: 'scout-signups', legacyName: 'scout-signups', permissionProfile: 'scout_signups' },
  { key: 'scout_results', type: 'text', suffix: 'scout-results', legacyName: 'scout-results', permissionProfile: 'scout_results' },
  { key: 'lobby', type: 'voice', suffix: 'Lobby' },
];

assertNoDuplicateKeys('division channel template', DIVISION_CHANNEL_TEMPLATE);

// Every text channel is division-prefixed (not just announcements) -- with
// five divisions all sharing generic names like "general", an unprefixed
// #general is ambiguous in Discord's mention autocomplete/channel list
// without checking which category it's under. This is purely presentational
// -- recomputed from the division's *current* display name on every
// provisioning run, same as every other Discord-facing name in this
// codebase; only DIVISION_CHANNEL_TEMPLATE's `key` is stable identity.
function channelName(division: DivisionSpec, template: DivisionChannelTemplateSpec): string {
  if (template.type === 'voice') return `${division.name} ${template.suffix}`;
  const slug = division.name.toLowerCase().replace(/\s+/g, '-');
  return `${slug}-${template.suffix}`;
}

export function getDivisionTemplate(division: DivisionSpec) {
  return {
    divisionRoleName: division.name,
    managerRoleName: `${division.name} Manager`,
    captainRoleName: `${division.name} Captain`,
    categoryName: division.name,
    channels: DIVISION_CHANNEL_TEMPLATE.map((template) => ({
      key: template.key,
      name: channelName(division, template),
      type: template.type,
      permissionProfile: template.permissionProfile,
      captainOnly: template.permissionProfile === 'captain_only',
      legacyName: template.legacyName,
    })),
  };
}

export function getExpectedChannelNames(division: DivisionSpec): string[] {
  return getDivisionTemplate(division).channels.map((channel) => channel.name);
}

export type DivisionChannelMatchTarget = {
  name: string;
  kind: Extract<ManagedResourceType, 'text_channel' | 'voice_channel'>;
  parentId: string;
  legacyName?: string;
};

export type DivisionChannelMatchResult =
  | { outcome: 'none' }
  | { outcome: 'exact'; candidate: CandidateResource; source: 'configured' | 'legacy' }
  | { outcome: 'ambiguous'; candidates: CandidateResource[] };

/**
 * Resolve a division channel by its current configured name, with one narrow
 * compatibility path for a legacy unprefixed name inside the expected
 * division category. Legacy names in other divisions must not make a valid
 * local match ambiguous, and a wrong type/parent must never be adopted.
 */
export function classifyDivisionChannelMatch(
  candidates: readonly CandidateResource[],
  target: DivisionChannelMatchTarget,
): DivisionChannelMatchResult {
  const current = classifyMatch(candidates, target);
  if (current.outcome === 'exact') return { ...current, source: 'configured' };
  if (current.outcome === 'ambiguous' || !target.legacyName) return current;

  const legacyCandidates = candidates.filter(
    (candidate) =>
      candidate.name === target.legacyName &&
      candidate.kind === target.kind &&
      candidate.parentId === target.parentId,
  );

  if (legacyCandidates.length === 0) return { outcome: 'none' };
  if (legacyCandidates.length === 1) {
    return { outcome: 'exact', candidate: legacyCandidates[0]!, source: 'legacy' };
  }
  return { outcome: 'ambiguous', candidates: legacyCandidates };
}

function roleByName(guild: Guild, name: string) {
  return guild.roles.cache.find((role) => role.name === name);
}

function permissionRoleIds(guild: Guild, divisionRole: Role, managerRole: Role, captainRole: Role): DivisionPermissionRoleIds {
  const required = (name: string): Role => {
    const role = roleByName(guild, name);
    if (!role) throw new Error(`Required role "${name}" is missing. Create it before provisioning divisions.`);
    return role;
  };
  return {
    everyone: guild.roles.everyone.id,
    division: divisionRole.id,
    manager: managerRole.id,
    captain: captainRole.id,
    franchiseRepresentative: required(FRANCHISE_REPRESENTATIVE_ROLE).id,
    admins: DIVISION_ADMIN_ROLES.map((name) => required(name).id),
  };
}

// --- ID-first resolution, mirroring runServerBootstrap in
// serverBootstrapRunner.ts (#16/#31 Defect 1): look up the managed row,
// resolve by stored Discord id, fall back to classifyMatch's
// exact/ambiguous/none discipline, and register on create/adopt. Reused
// rather than reimplemented, per the plan.

async function resolveManagedRole(db: Database.Database, guild: Guild, logicalKey: string): Promise<Role | undefined> {
  const managed = getActiveManagedResourceByLogicalKey(db, guild.id, logicalKey);
  if (!managed) return undefined;

  const resolved = guild.roles.cache.get(managed.discordResourceId);
  if (resolved) return resolved;

  markManagedResourceObsolete(db, managed.id);
  return undefined;
}

async function ensureRole(
  db: Database.Database,
  guild: Guild,
  logicalKey: string,
  name: string,
  options: { utility?: boolean; color?: number },
  result: DivisionProvisionResult,
): Promise<Role> {
  const managedRole = await resolveManagedRole(db, guild, logicalKey);
  if (managedRole) {
    if (managedRole.name !== name) {
      await managedRole.setName(name, 'Ratatoskr reconcile division role name');
    }
    result.reused.push(`role:${name}`);
    return managedRole;
  }

  const candidates: CandidateResource[] = guild.roles.cache.map((role) => ({
    discordId: role.id,
    name: role.name,
    kind: 'role',
    parentId: null,
  }));
  const match = classifyMatch(candidates, { name, kind: 'role', parentId: null });

  if (match.outcome === 'ambiguous') {
    throw new Error(
      `Role "${name}" is ambiguous: ${match.candidates.length} roles share that name in this guild. ` +
        'Resolve manually (rename or remove duplicates) before provisioning this division.',
    );
  }

  if (match.outcome === 'exact') {
    const role = guild.roles.cache.get(match.candidate.discordId)!;
    insertManagedResource(db, {
      discordResourceId: role.id,
      guildId: guild.id,
      resourceType: 'role',
      logicalKey,
      scaffoldDomain: 'division',
    });
    result.reused.push(`role:${name}`);
    return role;
  }

  const role = await guild.roles.create({
    name,
    hoist: !options.utility,
    mentionable: false,
    colors: options.color ? { primaryColor: options.color } : undefined,
    reason: 'Ratatoskr division provisioning',
  });
  insertManagedResource(db, {
    discordResourceId: role.id,
    guildId: guild.id,
    resourceType: 'role',
    logicalKey,
    scaffoldDomain: 'division',
  });
  result.created.push(`role:${name}`);
  return role;
}

async function ensureCategory(
  db: Database.Database,
  guild: Guild,
  logicalKey: string,
  name: string,
  overwrites: DivisionPermissionOverwrite[],
  result: DivisionProvisionResult,
): Promise<CategoryChannel> {
  const managed = getActiveManagedResourceByLogicalKey(db, guild.id, logicalKey);
  if (managed) {
    const resolved = guild.channels.cache.get(managed.discordResourceId);
    if (resolved && resolved.type === ChannelType.GuildCategory) {
      await resolved.permissionOverwrites.set(overwrites, 'Ratatoskr reconcile division category permissions');
      result.reused.push(`category:${name}`);
      return resolved;
    }
    markManagedResourceObsolete(db, managed.id);
  }

  const candidates: CandidateResource[] = guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildCategory)
    .map((channel) => ({ discordId: channel.id, name: channel.name, kind: 'category', parentId: null }));
  const match = classifyMatch(candidates, { name, kind: 'category', parentId: null });

  if (match.outcome === 'ambiguous') {
    throw new Error(
      `Category "${name}" is ambiguous: ${match.candidates.length} categories share that name in this guild. ` +
        'Resolve manually before provisioning this division.',
    );
  }

  if (match.outcome === 'exact') {
    const category = guild.channels.cache.get(match.candidate.discordId) as CategoryChannel;
    await category.permissionOverwrites.set(overwrites, 'Ratatoskr reconcile division category permissions');
    insertManagedResource(db, {
      discordResourceId: category.id,
      guildId: guild.id,
      resourceType: 'category',
      logicalKey,
      scaffoldDomain: 'division',
    });
    result.reused.push(`category:${name}`);
    return category;
  }

  const created = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
    reason: 'Ratatoskr division provisioning',
  });
  insertManagedResource(db, {
    discordResourceId: created.id,
    guildId: guild.id,
    resourceType: 'category',
    logicalKey,
    scaffoldDomain: 'division',
  });
  result.created.push(`category:${name}`);
  return created;
}

async function ensureChannel(
  db: Database.Database,
  guild: Guild,
  category: CategoryChannel,
  logicalKey: string,
  name: string,
  type: 'text' | 'voice',
  legacyName: string | undefined,
  adoptionParentId: string | undefined,
  permissionOverwrites: DivisionPermissionOverwrite[] | undefined,
  result: DivisionProvisionResult,
): Promise<void> {
  const expectedType = type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
  const resourceType = type === 'voice' ? ('voice_channel' as const) : ('text_channel' as const);

  const managed = getActiveManagedResourceByLogicalKey(db, guild.id, logicalKey);
  if (managed) {
    const resolved = guild.channels.cache.get(managed.discordResourceId);
    // Deliberately NOT checking resolved.name === name: name is
    // presentational only (#31 Defect 2) -- a config-side rename of the
    // division's display name changes the expected channel name every run,
    // and that must not make an otherwise-valid managed channel look stale.
    if (resolved && resolved.type === expectedType) {
      if (resolved.parentId !== category.id) {
        await resolved.setParent(category.id, { reason: 'Ratatoskr move division channel to its configured category' });
        setManagedResourceParent(db, managed.id, category.id);
      }
      if (!resolved.isThread()) {
        if (permissionOverwrites) {
          await resolved.permissionOverwrites.set(permissionOverwrites, 'Ratatoskr reconcile division channel permissions');
        } else {
          await resolved.lockPermissions();
        }
      }
      result.reused.push(`channel:${name}`);
      return;
    }
    markManagedResourceObsolete(db, managed.id);
  }

  const candidates: CandidateResource[] = guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice)
    .map((channel) => ({
      discordId: channel.id,
      name: channel.name,
      kind: channel.type === ChannelType.GuildVoice ? 'voice_channel' : 'text_channel',
      parentId: channel.parentId,
    }));
  let match = classifyDivisionChannelMatch(candidates, {
    name,
    kind: resourceType,
    parentId: category.id,
    legacyName,
  });
  if (match.outcome === 'none' && adoptionParentId && adoptionParentId !== category.id) {
    match = classifyDivisionChannelMatch(candidates, {
      name,
      kind: resourceType,
      parentId: adoptionParentId,
      legacyName,
    });
  }

  if (match.outcome === 'ambiguous') {
    throw new Error(
      `Channel "${name}" is ambiguous: ${match.candidates.length} channels share that name/type in this guild. ` +
        'Resolve manually before provisioning this division.',
    );
  }

  if (match.outcome === 'exact') {
    const channel = guild.channels.cache.get(match.candidate.discordId) as TextChannel | VoiceChannel;
    if (channel.parentId !== category.id) {
      await channel.setParent(category.id, { reason: 'Ratatoskr adopt and move division channel' });
    }
    if (match.source === 'legacy') {
      await channel.setName(name, 'Ratatoskr adopt legacy division channel');
    }
    if (permissionOverwrites) {
      await channel.permissionOverwrites.set(permissionOverwrites, 'Ratatoskr reconcile division channel permissions');
    } else {
      // Adopting an existing channel with unsynchronized overrides must not
      // leave them untouched -- an ordinary (non-captain-only) channel is
      // supposed to inherit the category's default-deny via
      // lockPermissions(), the same treatment the already-managed reuse path
      // above already gives it. Skipping this here would let an adopted
      // channel stay visible to @everyone despite the division category's
      // default-deny policy.
      await channel.lockPermissions();
    }
    insertManagedResource(db, {
      discordResourceId: channel.id,
      guildId: guild.id,
      resourceType,
      logicalKey,
      parentResourceId: category.id,
      scaffoldDomain: 'division',
    });
    result.reused.push(`channel:${name}`);
    return;
  }

  const channel = await guild.channels.create({
    name,
    type: expectedType,
    parent: category.id,
    permissionOverwrites,
    reason: 'Ratatoskr division provisioning',
  });
  insertManagedResource(db, {
    discordResourceId: channel.id,
    guildId: guild.id,
    resourceType,
    logicalKey,
    parentResourceId: category.id,
    scaffoldDomain: 'division',
  });
  result.created.push(`channel:${name}`);
}

export async function provisionDivision(db: Database.Database, guild: Guild, divisionKey: DivisionKey): Promise<DivisionProvisionResult> {
  await guild.roles.fetch();
  await guild.channels.fetch();

  const division = getDivisionSpec(divisionKey);
  const existingRecord = getDivisionByKey(db, guild.id, division.key);
  const reactivatedFromArchived = existingRecord?.status === 'archived';

  // Reset status to 'active' *before* any of the ensureRole/ensureCategory/
  // ensureChannel calls below, not only in upsertDivision at the end of this
  // function (Codex review, round 2 on #33): those calls unconditionally
  // restore active-state permission overwrites regardless of prior archived
  // status, so if this were deferred until the end and a later step threw
  // (an ambiguous classifyMatch result, a transient Discord API error),
  // Discord access could already be partially restored while the row still
  // said 'archived' -- letting /division delete's safety gate pass against a
  // division that, in reality, is no longer archived. Doing it first closes
  // that window: the worst case on an early failure is the row saying
  // 'active' while Discord still looks archived, which only makes delete's
  // gate more conservative, never less. upsertDivision's own reset stays too
  // as a harmless backstop for the normal end-of-run write.
  if (reactivatedFromArchived) {
    setDivisionStatus(db, guild.id, division.key, 'active');
  }

  const result: DivisionProvisionResult = {
    division: division.name,
    created: [],
    reused: [],
    reactivatedFromArchived,
  };
  const template = getDivisionTemplate(division);

  const divisionRole = await ensureRole(
    db,
    guild,
    divisionRoleLogicalKey(division.key),
    template.divisionRoleName,
    { color: DIVISION_ROLE_COLORS[division.key] },
    result,
  );
  const managerRole = await ensureRole(
    db,
    guild,
    divisionManagerRoleLogicalKey(division.key),
    template.managerRoleName,
    { utility: true },
    result,
  );
  const captainRole = await ensureRole(
    db,
    guild,
    divisionCaptainRoleLogicalKey(division.key),
    template.captainRoleName,
    { utility: true },
    result,
  );
  const roleIds = permissionRoleIds(guild, divisionRole, managerRole, captainRole);
  const category = await ensureCategory(
    db,
    guild,
    divisionCategoryLogicalKey(division.key),
    template.categoryName,
    resolveDivisionPermissionOverwrites(roleIds, 'category'),
    result,
  );
  const scoutConfig = getScoutConfig(db, guild.id);
  let scoutOperationsCategory: CategoryChannel | undefined;
  if (scoutConfig?.operationsCategoryId || scoutConfig?.operationsChannelId) {
    const configuredCategory = scoutConfig.operationsCategoryId
      ? guild.channels.cache.get(scoutConfig.operationsCategoryId)
      : undefined;
    const configuredChannel = scoutConfig.operationsChannelId
      ? guild.channels.cache.get(scoutConfig.operationsChannelId)
      : undefined;
    if (
      !configuredCategory ||
      configuredCategory.type !== ChannelType.GuildCategory ||
      !configuredChannel ||
      configuredChannel.type !== ChannelType.GuildText ||
      configuredChannel.parentId !== configuredCategory.id
    ) {
      throw new Error('The configured Scout Operations channel or category is missing or no longer linked. Rebind it with `/scout config`.');
    }
    scoutOperationsCategory = configuredCategory;
  }

  for (const channelSpec of template.channels) {
    const kind = channelSpec.type === 'voice' ? ('voice_channel' as const) : ('text_channel' as const);
    const logicalKey = divisionChannelLogicalKey(division.key, channelSpec.key, kind);
    const permissionOverwrites = channelSpec.permissionProfile
      ? resolveDivisionPermissionOverwrites(roleIds, channelSpec.permissionProfile)
      : undefined;
    const targetCategory =
      scoutOperationsCategory && (channelSpec.key === 'scout_signups' || channelSpec.key === 'scout_results')
        ? scoutOperationsCategory
        : category;
    await ensureChannel(
      db,
      guild,
      targetCategory,
      logicalKey,
      channelSpec.name,
      channelSpec.type,
      channelSpec.legacyName,
      scoutOperationsCategory && targetCategory.id === scoutOperationsCategory.id ? category.id : undefined,
      permissionOverwrites,
      result,
    );
  }

  upsertDivision(db, {
    guildId: guild.id,
    divisionKey: division.key,
    displayName: division.name,
    roleId: divisionRole.id,
    managerRoleId: managerRole.id,
    captainRoleId: captainRole.id,
    categoryId: category.id,
  });

  await syncExistingDivisionCaptains(guild, divisionRole, captainRole);

  return result;
}

export async function syncCaptainAccess(member: GuildMember) {
  const captainRole = roleByName(member.guild, 'Captain');
  if (!captainRole) return;

  const isCaptain = member.roles.cache.has(captainRole.id);

  for (const division of divisions) {
    const divisionRole = roleByName(member.guild, division.name);
    const captainDivisionRole = roleByName(member.guild, `${division.name} Captain`);
    if (!divisionRole || !captainDivisionRole) continue;

    const shouldHaveAccess = isCaptain && member.roles.cache.has(divisionRole.id);
    const hasAccess = member.roles.cache.has(captainDivisionRole.id);

    if (shouldHaveAccess && !hasAccess) {
      await member.roles.add(captainDivisionRole, 'Ratatoskr division captain reconciliation');
    } else if (!shouldHaveAccess && hasAccess) {
      await member.roles.remove(captainDivisionRole, 'Ratatoskr division captain reconciliation');
    }
  }
}

async function syncExistingDivisionCaptains(
  guild: Guild,
  divisionRole: Role,
  captainDivisionRole: Role,
): Promise<void> {
  const captainRole = roleByName(guild, 'Captain');
  if (!captainRole) return;
  const members = await guild.members.fetch();
  for (const member of members.values()) {
    const shouldHaveAccess = member.roles.cache.has(captainRole.id) && member.roles.cache.has(divisionRole.id);
    const hasAccess = member.roles.cache.has(captainDivisionRole.id);
    if (shouldHaveAccess && !hasAccess) {
      await member.roles.add(captainDivisionRole, 'Ratatoskr initial division captain reconciliation');
    } else if (!shouldHaveAccess && hasAccess) {
      await member.roles.remove(captainDivisionRole, 'Ratatoskr initial division captain reconciliation');
    }
  }
}
