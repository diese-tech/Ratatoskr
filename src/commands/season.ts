import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import type Database from 'better-sqlite3';
import {
  activateSeasonIfNoneActive,
  createSeason,
  getActiveManagedResourceByLogicalKey,
  getActiveSeason,
  getSeasonByNumber,
  insertManagedResource,
  markManagedResourceObsolete,
  SeasonAlreadyActiveError,
  setSeasonDiscordCategoryId,
  type Season,
} from '../db/index.js';
import { requireAccess } from '../services/authorization.js';
import { STAFF_ROLES } from '../services/divisions.js';
import { classifyMatch, resolveChannelPermissionOverwrites, type CandidateResource } from '../services/serverBootstrap.js';
import { evaluateSeasonCreateEligibility, seasonChannelLogicalKey, SEASON_CHANNELS } from '../services/seasonBootstrap.js';

export const seasonCommand = new SlashCommandBuilder()
  .setName('season')
  .setDescription('Create and manage season channels.')
  .setDMPermission(false)
  .addSubcommand((subcommand) =>
    subcommand
      .setName('create')
      .setDescription('Create the channels for a new season and make it active.')
      .addIntegerOption((option) =>
        option.setName('number').setDescription('Season number, such as 2.').setRequired(true).setMinValue(1),
      )
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Optional category name; replaces the default YSL Season N.')
          .setRequired(false)
          // Discord category names are capped at 100 characters. Rejecting
          // this at the option level (enforced client-side by Discord)
          // means an over-length name never reaches createSeason() at
          // all -- a season row persisted with an unusable category name
          // would otherwise be stuck, since a retry deliberately ignores
          // any name supplied after the first attempt.
          .setMaxLength(100),
      ),
  );

export async function handleSeasonCommand(interaction: ChatInputCommandInteraction, db: Database.Database) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in the YSL server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!(await requireAccess(interaction, member, 'ADMIN'))) return;

  if (interaction.options.getSubcommand() !== 'create') return;

  const guild = interaction.guild;
  const seasonNumber = interaction.options.getInteger('number', true);
  const displayName = interaction.options.getString('name');

  const activeSeason = getActiveSeason(db, guild.id);
  const existingForNumber = getSeasonByNumber(db, guild.id, seasonNumber);
  const eligibility = evaluateSeasonCreateEligibility(activeSeason, existingForNumber);

  if (eligibility.outcome === 'blocked-active-season') {
    await interaction.reply({
      content: `Season ${eligibility.activeSeasonNumber} is currently active. Close or archive the active season before creating another.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (eligibility.outcome === 'blocked-archived-conflict') {
    await interaction.reply({
      content: `Season ${seasonNumber} already exists and is archived. Choose a different season number.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await guild.channels.fetch();
  await guild.roles.fetch();

  // A retry reuses the row a prior, partially-completed attempt already
  // inserted rather than calling createSeason() again (which would just hit
  // the UNIQUE (guild_id, season_number) constraint). Its category_name was
  // already computed and fixed at first creation -- any `name` supplied on
  // this retry is ignored, matching the naming contract's "computed once,
  // never re-derived" rule.
  const season: Season =
    eligibility.outcome === 'retry-existing' && existingForNumber
      ? existingForNumber
      : createSeason(db, { guildId: guild.id, seasonNumber, displayName });

  const categoryName = season.categoryName;
  const resolveRoleId = (roleName: string) => guild.roles.cache.find((role) => role.name === roleName)?.id;

  // --- Category resolution: same exact/ambiguous/none discipline #16
  // establishes for server-scaffold resources. The category id lives on the
  // season row itself (1:1), not in managed_resources.
  let category: CategoryChannel | undefined;
  if (season.discordCategoryId) {
    const resolved = guild.channels.cache.get(season.discordCategoryId);
    if (resolved && resolved.type === ChannelType.GuildCategory) category = resolved;
  }

  let categoryAmbiguous = false;
  if (!category) {
    const candidates: CandidateResource[] = guild.channels.cache
      .filter((channel) => channel.type === ChannelType.GuildCategory)
      .map((channel) => ({ discordId: channel.id, name: channel.name, kind: 'category', parentId: null }));
    const match = classifyMatch(candidates, { name: categoryName, kind: 'category', parentId: null });

    if (match.outcome === 'ambiguous') {
      categoryAmbiguous = true;
    } else if (match.outcome === 'exact') {
      category = guild.channels.cache.get(match.candidate.discordId) as CategoryChannel;
      setSeasonDiscordCategoryId(db, season.id, category.id);
    } else {
      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        reason: 'Ratatoskr season bootstrap',
      });
      setSeasonDiscordCategoryId(db, season.id, category.id);
    }
  }

  if (categoryAmbiguous || !category) {
    await interaction.editReply(
      `Season ${seasonNumber}'s category "${categoryName}" is ambiguous: an existing, unmanaged category shares that name. ` +
        'Resolve it manually in Discord (rename or remove the duplicate), then re-run `/season create` to continue. Nothing was activated.',
    );
    return;
  }

  // --- Channel resolution: create-or-adopt each canonical channel,
  // registering it into managed_resources (scaffoldDomain: 'season') as it
  // succeeds, exactly as #16 does for the server scaffold. Candidates span
  // the whole guild (not just this category) so a same-named channel under
  // the wrong parent is reported ambiguous instead of silently duplicated.
  const created: string[] = [];
  const adopted: string[] = [];
  const ambiguous: string[] = [];

  for (const spec of SEASON_CHANNELS) {
    const logicalKey = seasonChannelLogicalKey(season.seasonNumber, spec.key);
    const permissionOverwrites = resolveChannelPermissionOverwrites(guild.roles.everyone.id, resolveRoleId, STAFF_ROLES, spec);

    const managed = getActiveManagedResourceByLogicalKey(db, guild.id, logicalKey);
    if (managed) {
      const resolved = guild.channels.cache.get(managed.discordResourceId);
      // Also require the parent to still match, not just the type -- e.g.
      // if the season category was deleted and recreated (a new Discord id,
      // updated via setSeasonDiscordCategoryId), a previously registered
      // channel would otherwise be silently "accepted" even though it no
      // longer actually sits inside the current category. Deliberately NOT
      // checking resolved.name === spec.name: name is presentational only
      // (#31 Defect 2) -- a config-side rename of spec.name must not make an
      // otherwise-valid managed channel look stale, or this would reintroduce
      // the exact orphan-and-duplicate bug authored keys exist to prevent.
      if (resolved && resolved.type === ChannelType.GuildText && resolved.parentId === category.id) {
        if (permissionOverwrites) {
          await resolved.permissionOverwrites.set(permissionOverwrites, 'Ratatoskr season bootstrap permission reconciliation');
        }
        continue;
      }
      // The channel this row pointed at is gone, changed type, or drifted
      // out of the season category -- retire the row before falling
      // through to re-match/re-create, same as bootstrap-guild.ts's "stale
      // managed channel" handling, so it doesn't keep shadowing the
      // logical key on every future run.
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
    const match = classifyMatch(candidates, { name: spec.name, kind: 'text_channel', parentId: category.id });

    if (match.outcome === 'ambiguous') {
      ambiguous.push(spec.name);
      continue;
    }

    if (match.outcome === 'exact') {
      const channel = guild.channels.cache.get(match.candidate.discordId) as TextChannel;
      insertManagedResource(db, {
        discordResourceId: channel.id,
        guildId: guild.id,
        resourceType: 'text_channel',
        logicalKey,
        parentResourceId: category.id,
        scaffoldDomain: 'season',
      });
      if (permissionOverwrites) {
        await channel.permissionOverwrites.set(permissionOverwrites, 'Ratatoskr season bootstrap permission reconciliation');
      }
      adopted.push(spec.name);
      continue;
    }

    const channel = await guild.channels.create({
      name: spec.name,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites,
      reason: 'Ratatoskr season bootstrap',
    });
    insertManagedResource(db, {
      discordResourceId: channel.id,
      guildId: guild.id,
      resourceType: 'text_channel',
      logicalKey,
      parentResourceId: category.id,
      scaffoldDomain: 'season',
    });
    created.push(spec.name);
  }

  if (ambiguous.length > 0) {
    await interaction.editReply(
      [
        `Season ${seasonNumber} (${categoryName}) category is ready, but ${ambiguous.length} channel(s) are ambiguous and were left untouched: ${ambiguous.join(', ')}.`,
        `Created: ${created.length ? created.join(', ') : 'none'}`,
        `Adopted: ${adopted.length ? adopted.join(', ') : 'none'}`,
        'Resolve the ambiguous channel(s) manually in Discord, then re-run `/season create` to finish. The season was not activated.',
      ].join('\n'),
    );
    return;
  }

  // Only activate once every channel is confirmed created/adopted -- never
  // report success, and never flip the season active, on a partial
  // provisioning run. Uses activateSeasonIfNoneActive rather than
  // setActiveSeason: two concurrent /season create invocations can both
  // have observed "no active season" before either got here, and the
  // fail-closed contract means the loser must abort, not silently replace
  // whichever one won.
  try {
    activateSeasonIfNoneActive(db, guild.id, season.id);
  } catch (error) {
    if (error instanceof SeasonAlreadyActiveError) {
      await interaction.editReply(
        [
          `Season ${seasonNumber} (${categoryName}) is fully provisioned, but season ${error.activeSeasonNumber} became active in the meantime.`,
          'Nothing was activated to avoid silently replacing it -- re-run `/season create` once that season is closed to activate this one.',
        ].join('\n'),
      );
      return;
    }
    throw error;
  }

  await interaction.editReply(
    [
      `Season ${seasonNumber} (${categoryName}) is provisioned and now active.`,
      `Created: ${created.length ? created.join(', ') : 'none'}`,
      `Adopted: ${adopted.length ? adopted.join(', ') : 'none'}`,
    ].join('\n'),
  );
}
