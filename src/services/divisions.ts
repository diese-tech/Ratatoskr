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
  insertManagedResource,
  markManagedResourceObsolete,
  setDivisionStatus,
  upsertDivision,
} from '../db/index.js';
import {
  divisionCaptainAccessRoleLogicalKey,
  divisionCategoryLogicalKey,
  divisionChannelLogicalKey,
  divisionRoleLogicalKey,
  assertNoDuplicateKeys,
} from './divisionScaffold.js';
import { classifyMatch, type CandidateResource } from './serverBootstrap.js';

export const STAFF_ROLES = ['Valkyries', 'Aesir', 'Allfather'] as const;

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
  captainOnly?: boolean;
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
  { key: 'captain_chat', type: 'text', suffix: 'captain-chat', legacyName: 'captain-chat', captainOnly: true },
  { key: 'announcements', type: 'text', suffix: 'announcements', legacyName: 'announcements' },
  { key: 'general', type: 'text', suffix: 'general', legacyName: 'general' },
  { key: 'tier_list', type: 'text', suffix: 'tier-list', legacyName: 'tier-list' },
  { key: 'scheduling', type: 'text', suffix: 'scheduling', legacyName: 'scheduling' },
  { key: 'match_reports', type: 'text', suffix: 'match-reports', legacyName: 'match-reports' },
  { key: 'scout_signups', type: 'text', suffix: 'scout-signups', legacyName: 'scout-signups' },
  { key: 'scout_results', type: 'text', suffix: 'scout-results', legacyName: 'scout-results' },
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
    captainAccessRoleName: `${division.name} Captain Access`,
    categoryName: division.name,
    channels: DIVISION_CHANNEL_TEMPLATE.map((template) => ({
      key: template.key,
      name: channelName(division, template),
      type: template.type,
      captainOnly: template.captainOnly ?? false,
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

function categoryOverwrites(guild: Guild, divisionRole: Role) {
  const staff = STAFF_ROLES.map((name) => roleByName(guild, name)).filter((role): role is Role => Boolean(role));
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: divisionRole.id, allow: [PermissionFlagsBits.ViewChannel] },
    ...staff.map((role) => ({ id: role.id, allow: [PermissionFlagsBits.ViewChannel] })),
  ];
}

function captainOverwrites(guild: Guild, captainAccessRole: Role) {
  const staff = STAFF_ROLES.map((name) => roleByName(guild, name)).filter((role): role is Role => Boolean(role));
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: captainAccessRole.id, allow: [PermissionFlagsBits.ViewChannel] },
    ...staff.map((role) => ({ id: role.id, allow: [PermissionFlagsBits.ViewChannel] })),
  ];
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
  divisionRole: Role,
  result: DivisionProvisionResult,
): Promise<CategoryChannel> {
  const overwrites = categoryOverwrites(guild, divisionRole);

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
  permissionOverwrites: ReturnType<typeof captainOverwrites> | undefined,
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
    if (resolved && resolved.type === expectedType && resolved.parentId === category.id) {
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
  const match = classifyDivisionChannelMatch(candidates, {
    name,
    kind: resourceType,
    parentId: category.id,
    legacyName,
  });

  if (match.outcome === 'ambiguous') {
    throw new Error(
      `Channel "${name}" is ambiguous: ${match.candidates.length} channels share that name/type in this guild. ` +
        'Resolve manually before provisioning this division.',
    );
  }

  if (match.outcome === 'exact') {
    const channel = guild.channels.cache.get(match.candidate.discordId) as TextChannel | VoiceChannel;
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
  const captainAccessRole = await ensureRole(
    db,
    guild,
    divisionCaptainAccessRoleLogicalKey(division.key),
    template.captainAccessRoleName,
    { utility: true },
    result,
  );
  const category = await ensureCategory(db, guild, divisionCategoryLogicalKey(division.key), template.categoryName, divisionRole, result);

  for (const channelSpec of template.channels) {
    const kind = channelSpec.type === 'voice' ? ('voice_channel' as const) : ('text_channel' as const);
    const logicalKey = divisionChannelLogicalKey(division.key, channelSpec.key, kind);
    const permissionOverwrites = channelSpec.captainOnly ? captainOverwrites(guild, captainAccessRole) : undefined;
    await ensureChannel(
      db,
      guild,
      category,
      logicalKey,
      channelSpec.name,
      channelSpec.type,
      channelSpec.legacyName,
      permissionOverwrites,
      result,
    );
  }

  upsertDivision(db, {
    guildId: guild.id,
    divisionKey: division.key,
    displayName: division.name,
    roleId: divisionRole.id,
    captainAccessRoleId: captainAccessRole.id,
    categoryId: category.id,
  });

  return result;
}

export async function syncCaptainAccess(member: GuildMember) {
  const captainRole = roleByName(member.guild, 'Captain');
  if (!captainRole) return;

  const isCaptain = member.roles.cache.has(captainRole.id);

  for (const division of divisions) {
    const divisionRole = roleByName(member.guild, division.name);
    const accessRole = roleByName(member.guild, `${division.name} Captain Access`);
    if (!divisionRole || !accessRole) continue;

    const shouldHaveAccess = isCaptain && member.roles.cache.has(divisionRole.id);
    const hasAccess = member.roles.cache.has(accessRole.id);

    if (shouldHaveAccess && !hasAccess) {
      await member.roles.add(accessRole, 'Ratatoskr captain access reconciliation');
    } else if (!shouldHaveAccess && hasAccess) {
      await member.roles.remove(accessRole, 'Ratatoskr captain access reconciliation');
    }
  }
}
