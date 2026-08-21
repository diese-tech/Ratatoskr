import 'dotenv/config';
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
import { yslGuildStructure } from '../src/config/guild-structure.js';

const apply = process.argv.includes('--apply');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function log(action: string, detail: string) {
  console.log(`${apply ? '[APPLY]' : '[DRY-RUN]'} ${action}: ${detail}`);
}

async function ensureRole(guild: Guild, spec: (typeof yslGuildStructure.roles)[number]): Promise<Role> {
  const existing = guild.roles.cache.find((role) => role.name === spec.name);
  if (existing) {
    log('role exists', spec.name);
    return existing;
  }

  log('create role', spec.name);
  if (!apply) {
    return { id: `dry-role:${spec.name}`, name: spec.name } as Role;
  }

  return guild.roles.create({
    name: spec.name,
    hoist: spec.hoist ?? false,
    mentionable: spec.mentionable ?? false,
    colors: spec.color ? { primaryColor: spec.color } : undefined,
    reason: 'Ratatoskr YSL guild bootstrap',
  });
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

async function ensureCategory(
  guild: Guild,
  roleMap: Map<string, Role>,
  spec: (typeof yslGuildStructure.categories)[number],
): Promise<CategoryChannel> {
  const existing = guild.channels.cache.find(
    (channel): channel is CategoryChannel => channel.type === ChannelType.GuildCategory && channel.name === spec.name,
  );
  const permissionOverwrites = resolveAccessOverwrites(guild, roleMap, spec.access);

  if (existing) {
    log('category exists', spec.name);
    if (permissionOverwrites) {
      log('reconcile category permissions', spec.name);
      if (apply) {
        await existing.permissionOverwrites.set(permissionOverwrites, 'Ratatoskr bootstrap permission reconciliation');
      }
    }
    return existing;
  }

  log('create category', spec.name);
  if (!apply) {
    return { id: `dry-category:${spec.name}`, name: spec.name } as CategoryChannel;
  }

  return guild.channels.create({
    name: spec.name,
    type: ChannelType.GuildCategory,
    permissionOverwrites,
    reason: 'Ratatoskr YSL guild bootstrap',
  });
}

async function ensureChannel(
  guild: Guild,
  roleMap: Map<string, Role>,
  category: CategoryChannel,
  categoryName: string,
  spec: (typeof yslGuildStructure.categories)[number]['channels'][number],
) {
  const parentId = category.id;
  const expectedType = spec.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
  const permissionOverwrites = resolveAccessOverwrites(guild, roleMap, spec.access);
  const existing = guild.channels.cache.find(
    (channel): channel is TextChannel | VoiceChannel =>
      channel.name === spec.name && channel.parentId === parentId && channel.type === expectedType,
  );

  if (existing) {
    log('channel exists', `${categoryName} / ${spec.name}`);
    if (permissionOverwrites) {
      log('reconcile channel permissions', `${categoryName} / ${spec.name}`);
      if (apply) {
        await existing.permissionOverwrites.set(permissionOverwrites, 'Ratatoskr bootstrap permission reconciliation');
      }
    }
    return;
  }

  log('create channel', `${categoryName} / ${spec.name}`);
  if (!apply) return;

  await guild.channels.create({
    name: spec.name,
    type: expectedType,
    parent: parentId,
    topic: spec.type === 'text' ? spec.topic : undefined,
    permissionOverwrites,
    reason: 'Ratatoskr YSL guild bootstrap',
  });
}

async function bootstrap() {
  await client.login(env.DISCORD_TOKEN);
  const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
  await guild.roles.fetch();
  await guild.channels.fetch();

  console.log(`\nTarget guild: ${guild.name} (${guild.id})`);
  console.log(apply ? 'MODE: APPLY — changes will be created/reconciled.' : 'MODE: DRY RUN — no Discord changes will be made.');
  console.log('Existing unmatched roles/channels are preserved; restricted matching content is permission-reconciled.\n');

  const roleMap = new Map<string, Role>();
  for (const roleSpec of yslGuildStructure.roles) {
    roleMap.set(roleSpec.name, await ensureRole(guild, roleSpec));
  }

  for (const categorySpec of yslGuildStructure.categories) {
    const category = await ensureCategory(guild, roleMap, categorySpec);
    for (const channelSpec of categorySpec.channels) {
      await ensureChannel(guild, roleMap, category, categorySpec.name, channelSpec);
    }
  }

  console.log('\nBootstrap complete.');
  if (!apply) console.log('Review the plan above, then rerun with --apply when ready.');
  await client.destroy();
}

bootstrap().catch(async (error) => {
  console.error(error);
  await client.destroy();
  process.exitCode = 1;
});
