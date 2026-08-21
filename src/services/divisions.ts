import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
} from 'discord.js';
import { divisions, type DivisionName } from '../config/guild-structure.js';

const STAFF_ROLES = ['Valkyries', 'Æsir', 'Allfather'] as const;

export type DivisionProvisionResult = {
  division: DivisionName;
  created: string[];
  reused: string[];
};

export function isDivisionName(value: string): value is DivisionName {
  return divisions.includes(value as DivisionName);
}

export function getDivisionTemplate(division: DivisionName) {
  const slug = division.toLowerCase().replace(/\s+/g, '-');

  return {
    divisionRole: division,
    captainAccessRole: `${division} Captain Access`,
    category: division,
    channels: [
      { name: `${slug}-announcements`, type: 'text' as const },
      { name: 'general', type: 'text' as const },
      { name: 'scheduling', type: 'text' as const },
      { name: 'match-reports', type: 'text' as const },
      { name: 'captain-chat', type: 'text' as const, captainOnly: true },
      { name: `${division} Lobby`, type: 'voice' as const },
    ],
  };
}

function roleByName(guild: Guild, name: string) {
  return guild.roles.cache.find((role) => role.name === name);
}

async function ensureRole(guild: Guild, name: string, utility = false, result?: DivisionProvisionResult) {
  const existing = roleByName(guild, name);
  if (existing) {
    result?.reused.push(`role:${name}`);
    return existing;
  }

  const role = await guild.roles.create({
    name,
    hoist: !utility,
    mentionable: false,
    reason: 'Ratatoskr division provisioning',
  });
  result?.created.push(`role:${name}`);
  return role;
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

async function ensureCategory(
  guild: Guild,
  division: DivisionName,
  divisionRole: Role,
  result: DivisionProvisionResult,
): Promise<GuildBasedChannel> {
  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === division,
  );
  const overwrites = categoryOverwrites(guild, divisionRole);

  if (existing) {
    await existing.permissionOverwrites.set(overwrites, 'Ratatoskr reconcile division category permissions');
    result.reused.push(`category:${division}`);
    return existing;
  }

  const created = await guild.channels.create({
    name: division,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
    reason: 'Ratatoskr division provisioning',
  });
  result.created.push(`category:${division}`);
  return created;
}

export async function provisionDivision(guild: Guild, division: DivisionName): Promise<DivisionProvisionResult> {
  await guild.roles.fetch();
  await guild.channels.fetch();

  const result: DivisionProvisionResult = { division, created: [], reused: [] };
  const template = getDivisionTemplate(division);
  const divisionRole = await ensureRole(guild, template.divisionRole, false, result);
  const captainAccessRole = await ensureRole(guild, template.captainAccessRole, true, result);
  const category = await ensureCategory(guild, division, divisionRole, result);

  for (const channelSpec of template.channels) {
    const expectedType = channelSpec.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
    const existing = guild.channels.cache.find(
      (channel) => channel.parentId === category.id && channel.name === channelSpec.name && channel.type === expectedType,
    );
    const permissionOverwrites = 'captainOnly' in channelSpec && channelSpec.captainOnly
      ? captainOverwrites(guild, captainAccessRole)
      : undefined;

    if (existing) {
      if (permissionOverwrites) {
        await existing.permissionOverwrites.set(permissionOverwrites, 'Ratatoskr reconcile captain-chat permissions');
      }
      result.reused.push(`channel:${channelSpec.name}`);
      continue;
    }

    await guild.channels.create({
      name: channelSpec.name,
      type: expectedType,
      parent: category.id,
      permissionOverwrites,
      reason: 'Ratatoskr division provisioning',
    });
    result.created.push(`channel:${channelSpec.name}`);
  }

  return result;
}

export async function syncCaptainAccess(member: GuildMember) {
  const captainRole = roleByName(member.guild, 'Captain');
  if (!captainRole) return;

  const isCaptain = member.roles.cache.has(captainRole.id);

  for (const division of divisions) {
    const divisionRole = roleByName(member.guild, division);
    const accessRole = roleByName(member.guild, `${division} Captain Access`);
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
