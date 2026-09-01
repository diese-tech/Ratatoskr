import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type Guild,
  type Role,
} from 'discord.js';
import type Database from 'better-sqlite3';
import { divisions, type DivisionKey } from '../config/guild-structure.js';
import {
  getDivisionByKey,
  listDivisionScoutLifecycleBlockers,
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
  .setDescription('Create, check, archive, or delete division channels and roles.')
  .setDMPermission(false)
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Create missing division channels and roles, or repair existing ones.')
      .addStringOption((option) =>
        option.setName('name').setDescription('Division to create or repair.').setRequired(true).addChoices(...choices),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('status')
      .setDescription('Check which division channels and roles exist or are missing.')
      .addStringOption((option) =>
        option.setName('name').setDescription('Division to check.').setRequired(true).addChoices(...choices),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('archive')
      .setDescription("Hide a division's channels without deleting its history.")
      .addStringOption((option) =>
        option.setName('name').setDescription('Division to hide.').setRequired(true).addChoices(...choices),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('delete')
      .setDescription("Permanently delete an archived division's channels and roles.")
      .addStringOption((option) =>
        option.setName('name').setDescription('Archived division to permanently delete.').setRequired(true).addChoices(...choices),
      )
      .addBooleanOption((option) =>
        option.setName('confirm').setDescription('Choose true to confirm permanent deletion.').setRequired(true),
      ),
  );

// A managed_resources row staying 'active' only means Ratatoskr hasn't
// re-run provisioning since; it says nothing about whether the Discord
// resource still exists right now. /division status must report reality, not
// just what the last reconciliation run wrote -- a channel manually deleted
// from Discord (without Ratatoskr ever re-running /division add to notice
// and mark the row obsolete) must show as missing, not as present.
function managedResourceIsLive(guild: Guild, resource: { discordResourceId: string; resourceType: string }, expectedParentId?: string): boolean {
  if (resource.resourceType === 'role') {
    return guild.roles.cache.has(resource.discordResourceId);
  }

  const channel = guild.channels.cache.get(resource.discordResourceId);
  if (!channel) return false;

  if (resource.resourceType === 'category') return channel.type === ChannelType.GuildCategory;

  const expectedType = resource.resourceType === 'voice_channel' ? ChannelType.GuildVoice : ChannelType.GuildText;
  if (channel.type !== expectedType) return false;
  if (expectedParentId !== undefined && 'parentId' in channel && channel.parentId !== expectedParentId) return false;
  return true;
}

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
    const reactivationNote = result.reactivatedFromArchived
      ? `\n\nNote: ${result.division} was archived; provisioning restored its normal visibility, and its status is active again.`
      : '';
    await interaction.editReply(
      `**${result.division}** is provisioned.\nCreated: ${result.created.length}\nReused/reconciled: ${result.reused.length}${reactivationNote}`,
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
  const category =
    managedCategoryRow && managedResourceIsLive(guild, managedCategoryRow)
      ? (guild.channels.cache.get(managedCategoryRow.discordResourceId) as CategoryChannel)
      : undefined;

  if (subcommand === 'status') {
    const roleRow = managedForDivision.find((resource) => resource.logicalKey === divisionRoleLogicalKey(division.key));
    const captainRoleRow = managedForDivision.find(
      (resource) => resource.logicalKey === divisionCaptainAccessRoleLogicalKey(division.key),
    );
    const roleManaged = Boolean(roleRow) && managedResourceIsLive(guild, roleRow!);
    const captainRoleManaged = Boolean(captainRoleRow) && managedResourceIsLive(guild, captainRoleRow!);

    const liveChannelKeys = new Set(
      managedForDivision
        .filter((resource) => resource.resourceType === 'text_channel' || resource.resourceType === 'voice_channel')
        .filter((resource) => managedResourceIsLive(guild, resource, category?.id))
        .map((resource) => resource.logicalKey),
    );
    const missingChannels = DIVISION_CHANNEL_TEMPLATE.filter((channel) => {
      const kind = channel.type === 'voice' ? ('voice_channel' as const) : ('text_channel' as const);
      return !liveChannelKeys.has(divisionChannelLogicalKey(division.key, channel.key, kind));
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

  if ((subcommand === 'archive' || subcommand === 'delete') && record) {
    const blockers = listDivisionScoutLifecycleBlockers(db, guild.id, record.id);
    if (blockers.length > 0) {
      await interaction.reply({
        content: [
          `Cannot ${subcommand} **${division.name}** while it has active scout setups:`,
          ...blockers.map((setup) => `- Setup #${setup.id}: <t:${setup.startAt}:F> (${setup.status === 'roster_ready' ? 'roster ready' : 'open'})`),
          '',
          `Cancel ${blockers.length === 1 ? 'it' : 'them'} from the division scout-signups channel, then retry.`,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
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

    // Destructive delete resolves its target set *only* from persisted
    // managed_resources rows -- never from category.children.cache -- and
    // blocks entirely if the category holds a channel Ratatoskr cannot prove
    // it manages. This is the required safety split from archive: archive
    // may sweep unmanaged children as (reversible) containment, delete may
    // never touch what it can't prove it owns.
    //
    // Deliberately not gated on `!category`: if a prior partial delete run
    // already removed the category (or it was removed manually), that must
    // not block a retry from finishing off any channels/roles still left
    // with an active managed_resources row -- there is simply nothing left
    // to check for unmanaged children in that case.
    const managedChannels = managedForDivision.filter(
      (resource) => resource.resourceType === 'text_channel' || resource.resourceType === 'voice_channel',
    );

    if (category) {
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
    }

    const roleRow = managedForDivision.find((resource) => resource.logicalKey === divisionRoleLogicalKey(division.key));
    const captainRoleRow = managedForDivision.find(
      (resource) => resource.logicalKey === divisionCaptainAccessRoleLogicalKey(division.key),
    );
    const rolesToDelete = [roleRow, captainRoleRow].filter((row): row is ManagedResource => Boolean(row));
    const channelNames = managedChannels.map(
      (resource) => (category ? category.children.cache.get(resource.discordResourceId)?.name : undefined) ?? resource.discordResourceId,
    );
    const roleNames = rolesToDelete.map((row) => guild.roles.cache.get(row.discordResourceId)?.name ?? row.discordResourceId);

    if (!confirm) {
      await interaction.reply({
        content: [
          `This will permanently delete the following for **${division.name}**:`,
          `Category: ${category ? category.name : 'none (already removed)'}`,
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

    // Each deletion is independent and individually retryable -- one
    // resource failing (a transient Discord API error, insufficient
    // permissions after the fact, etc.) must not abort cleanup of the rest,
    // and must not leave the command permanently stuck: a resource that
    // fails here keeps its managed_resources row active, so a plain re-run
    // of `/division delete confirm:true` will simply retry exactly the
    // resources still outstanding.
    const succeeded: string[] = [];
    const failed: { name: string; error: string }[] = [];

    for (const resource of managedChannels) {
      const label = `channel:${guild.channels.cache.get(resource.discordResourceId)?.name ?? resource.discordResourceId}`;
      try {
        const channel = guild.channels.cache.get(resource.discordResourceId);
        if (channel) await channel.delete('Ratatoskr division deletion');
        markManagedResourcePurged(db, resource.id);
        succeeded.push(label);
      } catch (error) {
        failed.push({ name: label, error: (error as Error).message });
      }
    }

    if (category) {
      try {
        await category.delete('Ratatoskr division deletion');
        if (managedCategoryRow) markManagedResourcePurged(db, managedCategoryRow.id);
        succeeded.push(`category:${category.name}`);
      } catch (error) {
        failed.push({ name: `category:${category.name}`, error: (error as Error).message });
      }
    }

    for (const roleRowToDelete of rolesToDelete) {
      const label = `role:${guild.roles.cache.get(roleRowToDelete.discordResourceId)?.name ?? roleRowToDelete.discordResourceId}`;
      try {
        const role = guild.roles.cache.get(roleRowToDelete.discordResourceId) as Role | undefined;
        if (role) await role.delete('Ratatoskr division deletion');
        markManagedResourcePurged(db, roleRowToDelete.id);
        succeeded.push(label);
      } catch (error) {
        failed.push({ name: label, error: (error as Error).message });
      }
    }

    const summary = [
      failed.length === 0 ? `${division.name} has been permanently deleted.` : `${division.name} deletion partially completed.`,
      `Removed (${succeeded.length}): ${succeeded.length ? succeeded.join(', ') : 'none'}`,
    ];
    if (failed.length > 0) {
      summary.push(
        `FAILED to remove (${failed.length}) -- still active/managed, safe to retry:`,
        ...failed.map(({ name, error }) => `- ${name}: ${error}`),
      );
    }

    await interaction.editReply(summary.join('\n'));
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
