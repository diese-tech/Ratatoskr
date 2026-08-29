import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type Role,
} from 'discord.js';
import type Database from 'better-sqlite3';
import { divisions, type DivisionKey } from '../config/guild-structure.js';
import {
  getDivisionByKey,
  listManagedResourcesByDomain,
  markManagedResourcePurged,
  setDivisionStatus,
  type ManagedResource,
} from '../db/index.js';
import { requireAccess } from '../services/authorization.js';
import {
  divisionCaptainAccessRoleLogicalKey,
  divisionCategoryLogicalKey,
  divisionChannelLogicalKey,
  divisionRoleLogicalKey,
  findUnmanagedCategoryChildren,
  resourcesForDivision,
} from '../services/divisionScaffold.js';
import { DIVISION_CHANNEL_TEMPLATE, getDivisionSpec, getDivisionTemplate, provisionDivision } from '../services/divisions.js';

const choices = divisions.map((division) => ({ name: division.name, value: division.key }));

export const divisionCommand = new SlashCommandBuilder()
  .setName('division')
  .setDescription('Manage YSL division scaffolds.')
  .setDMPermission(false)
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Create or repair the boilerplate for a division.')
      .addStringOption((option) =>
        option.setName('name').setDescription('Division to provision.').setRequired(true).addChoices(...choices),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('status')
      .setDescription('Show whether a division scaffold currently exists.')
      .addStringOption((option) =>
        option.setName('name').setDescription('Division to inspect.').setRequired(true).addChoices(...choices),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('archive')
      .setDescription('Hide a division category without deleting history.')
      .addStringOption((option) =>
        option.setName('name').setDescription('Division to archive.').setRequired(true).addChoices(...choices),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('delete')
      .setDescription("Permanently delete an archived division's category, channels, and roles.")
      .addStringOption((option) =>
        option.setName('name').setDescription('Archived division to delete.').setRequired(true).addChoices(...choices),
      )
      .addBooleanOption((option) =>
        option.setName('confirm').setDescription('Must be true to permanently delete.').setRequired(true),
      ),
  );

function archiveOverwrites(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...guild.roles.cache
      .filter((role) => role.name === 'Allfather' || role.name === 'Aesir')
      .map((role) => ({ id: role.id, allow: [PermissionFlagsBits.ViewChannel] })),
  ];
}

export async function handleDivisionCommand(interaction: ChatInputCommandInteraction, db: Database.Database) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in the YSL server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!(await requireAccess(interaction, member, 'ADMIN'))) return;

  const guild = interaction.guild;
  const divisionKey = interaction.options.getString('name', true) as DivisionKey;
  const division = getDivisionSpec(divisionKey);
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'add') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await provisionDivision(db, guild, divisionKey);
    await interaction.editReply(
      `**${result.division}** is provisioned.\nCreated: ${result.created.length}\nReused/reconciled: ${result.reused.length}`,
    );
    return;
  }

  await guild.roles.fetch();
  await guild.channels.fetch();

  // Everything below reads exclusively from persisted managed_resources /
  // divisions rows, never from Discord name-matching (#31 Defect 1) --
  // status, archive, and delete all resolve "what does Ratatoskr manage for
  // this division" the same, ID-first way provisionDivision writes it.
  const record = getDivisionByKey(db, guild.id, division.key);
  const managedForDivision = resourcesForDivision(
    listManagedResourcesByDomain(db, guild.id, 'division', 'active'),
    division.key,
  );
  const managedCategoryRow = managedForDivision.find((resource) => resource.logicalKey === divisionCategoryLogicalKey(division.key));
  const category = managedCategoryRow
    ? (guild.channels.cache.get(managedCategoryRow.discordResourceId) as CategoryChannel | undefined)
    : undefined;

  if (subcommand === 'status') {
    const roleManaged = managedForDivision.some((resource) => resource.logicalKey === divisionRoleLogicalKey(division.key));
    const captainRoleManaged = managedForDivision.some(
      (resource) => resource.logicalKey === divisionCaptainAccessRoleLogicalKey(division.key),
    );
    const managedChannelKeys = new Set(
      managedForDivision
        .filter((resource) => resource.resourceType === 'text_channel' || resource.resourceType === 'voice_channel')
        .map((resource) => resource.logicalKey),
    );
    const missingChannels = DIVISION_CHANNEL_TEMPLATE.filter((channel) => {
      const kind = channel.type === 'voice' ? ('voice_channel' as const) : ('text_channel' as const);
      return !managedChannelKeys.has(divisionChannelLogicalKey(division.key, channel.key, kind));
    });

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: [
        `**${division.name} status**`,
        `Division role: ${roleManaged ? 'yes' : 'no'}`,
        `Captain access role: ${captainRoleManaged ? 'yes' : 'no'}`,
        `Category: ${category ? 'yes' : 'no'}`,
        `Lifecycle status: ${record?.status ?? 'not yet provisioned'}`,
        `Missing channels: ${missingChannels.length ? missingChannels.map((channel) => channel.key).join(', ') : 'none'}`,
      ].join('\n'),
    });
    return;
  }

  if (subcommand === 'delete') {
    const confirm = interaction.options.getBoolean('confirm', true);

    if (!record || record.status !== 'archived') {
      await interaction.reply({
        content: `${division.name} must be archived with \`/division archive\` before it can be deleted.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!category) {
      await interaction.reply({
        content: `${division.name} has no managed category to delete (it may have already been removed from Discord manually).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Destructive delete resolves its target set *only* from persisted
    // managed_resources rows -- never from category.children.cache -- and
    // blocks entirely if the category holds a channel Ratatoskr cannot prove
    // it manages. This is the required safety split from archive: archive
    // may sweep unmanaged children as (reversible) containment, delete may
    // never touch what it can't prove it owns.
    const managedChannels = managedForDivision.filter(
      (resource) => resource.resourceType === 'text_channel' || resource.resourceType === 'voice_channel',
    );
    const unmanagedChildIds = findUnmanagedCategoryChildren(
      category.children.cache.map((channel) => channel.id),
      managedChannels.map((resource) => resource.discordResourceId),
    );

    if (unmanagedChildIds.length > 0) {
      const unmanagedNames = unmanagedChildIds.map((id) => category.children.cache.get(id)?.name ?? id);
      await interaction.reply({
        content: [
          `Cannot delete **${division.name}**: this category contains channel(s) Ratatoskr does not manage:`,
          unmanagedNames.map((name) => `- ${name}`).join('\n'),
          '',
          'Move or remove them manually in Discord, then retry. Nothing was deleted.',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const roleRow = managedForDivision.find((resource) => resource.logicalKey === divisionRoleLogicalKey(division.key));
    const captainRoleRow = managedForDivision.find(
      (resource) => resource.logicalKey === divisionCaptainAccessRoleLogicalKey(division.key),
    );
    const rolesToDelete = [roleRow, captainRoleRow].filter((row): row is ManagedResource => Boolean(row));
    const channelNames = managedChannels.map((resource) => category.children.cache.get(resource.discordResourceId)?.name ?? resource.discordResourceId);
    const roleNames = rolesToDelete.map((row) => guild.roles.cache.get(row.discordResourceId)?.name ?? row.discordResourceId);

    if (!confirm) {
      await interaction.reply({
        content: [
          `This will permanently delete the following for **${division.name}**:`,
          `Category: ${category.name}`,
          `Channels (${channelNames.length}): ${channelNames.length ? channelNames.join(', ') : 'none'}`,
          `Roles (${roleNames.length}): ${roleNames.length ? roleNames.join(', ') : 'none'}`,
          '',
          'Re-run with `confirm: true` to proceed. This cannot be undone.',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    for (const resource of managedChannels) {
      const channel = guild.channels.cache.get(resource.discordResourceId);
      if (channel) await channel.delete('Ratatoskr division deletion');
      markManagedResourcePurged(db, resource.id);
    }
    await category.delete('Ratatoskr division deletion');
    if (managedCategoryRow) markManagedResourcePurged(db, managedCategoryRow.id);

    for (const roleRowToDelete of rolesToDelete) {
      const role = guild.roles.cache.get(roleRowToDelete.discordResourceId) as Role | undefined;
      if (role) await role.delete('Ratatoskr division deletion');
      markManagedResourcePurged(db, roleRowToDelete.id);
    }

    await interaction.editReply(
      [
        `${division.name} has been permanently deleted.`,
        `Channels removed (${channelNames.length}): ${channelNames.length ? channelNames.join(', ') : 'none'}`,
        `Roles removed (${roleNames.length}): ${roleNames.length ? roleNames.join(', ') : 'none'}`,
      ].join('\n'),
    );
    return;
  }

  // --- /division archive: non-destructive. Hides the category and every
  // current child, managed or not -- unlike delete, this is safe because
  // hiding is reversible and category-wide by nature (containment, not
  // adoption: unmanaged children are never registered into managed_resources
  // here).
  if (!category) {
    await interaction.reply({ content: `${division.name} does not have a managed category to archive.`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const overwrites = archiveOverwrites(interaction);
  await category.permissionOverwrites.set(overwrites, 'Ratatoskr division archive');

  for (const channel of category.children.cache.values()) {
    await channel.permissionOverwrites.set(overwrites, 'Ratatoskr division archive');
  }

  setDivisionStatus(db, guild.id, division.key, 'archived');

  await interaction.editReply(
    `${division.name} has been archived. The category and history were preserved and hidden from normal division access.`,
  );
}
