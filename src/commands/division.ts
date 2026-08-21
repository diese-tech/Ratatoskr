import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type Role,
} from 'discord.js';
import { divisions, type DivisionName } from '../config/guild-structure.js';
import { requireAccess } from '../services/authorization.js';
import { getExpectedChannelNames, provisionDivision } from '../services/divisions.js';

const choices = divisions.map((division) => ({ name: division, value: division }));

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

function isCategoryArchived(category: CategoryChannel, divisionRole: Role | undefined) {
  // Active and archived categories both deny @everyone ViewChannel (that's the
  // default-deny model), so that alone doesn't distinguish them. Only the
  // active state's overwrites (see categoryOverwrites in services/divisions.ts)
  // grant the division role itself access; archiveOverwrites omits it entirely.
  if (!divisionRole) return true;
  const roleOverwrite = category.permissionOverwrites.cache.get(divisionRole.id);
  return !(roleOverwrite?.allow.has(PermissionFlagsBits.ViewChannel) ?? false);
}

function archiveOverwrites(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...guild.roles.cache
      .filter((role) => role.name === 'Allfather' || role.name === 'Æsir')
      .map((role) => ({ id: role.id, allow: [PermissionFlagsBits.ViewChannel] })),
  ];
}

export async function handleDivisionCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in the YSL server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!(await requireAccess(interaction, member, 'ADMIN'))) return;

  const division = interaction.options.getString('name', true) as DivisionName;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'add') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await provisionDivision(interaction.guild, division);
    await interaction.editReply(
      `**${division}** is provisioned.\nCreated: ${result.created.length}\nReused/reconciled: ${result.reused.length}`,
    );
    return;
  }

  await interaction.guild.roles.fetch();
  await interaction.guild.channels.fetch();

  const role = interaction.guild.roles.cache.find((candidate) => candidate.name === division);
  const category = interaction.guild.channels.cache.find(
    (channel): channel is CategoryChannel => channel.type === ChannelType.GuildCategory && channel.name === division,
  );

  if (subcommand === 'status') {
    const captainRole = interaction.guild.roles.cache.find((candidate) => candidate.name === `${division} Captain Access`);
    const expectedChannels = getExpectedChannelNames(division);
    const existing = category
      ? interaction.guild.channels.cache.filter((channel) => channel.parentId === category.id).map((channel) => channel.name)
      : [];
    const missing = expectedChannels.filter((name) => !existing.includes(name));

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: [
        `**${division} status**`,
        `Division role: ${role ? 'yes' : 'no'}`,
        `Captain access role: ${captainRole ? 'yes' : 'no'}`,
        `Category: ${category ? 'yes' : 'no'}`,
        `Missing channels: ${missing.length ? missing.join(', ') : 'none'}`,
      ].join('\n'),
    });
    return;
  }

  if (subcommand === 'delete') {
    const confirm = interaction.options.getBoolean('confirm', true);

    if (!category) {
      await interaction.reply({ content: `${division} does not have a category to delete.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (!isCategoryArchived(category, role)) {
      await interaction.reply({
        content: `${division} must be archived with \`/division archive\` before it can be deleted.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const captainRole = interaction.guild.roles.cache.find(
      (candidate) => candidate.name === `${division} Captain Access`,
    );
    const rolesToDelete = [role, captainRole].filter((candidate): candidate is Role => Boolean(candidate));
    const channelNames = category.children.cache.map((channel) => channel.name);
    const roleNames = rolesToDelete.map((roleToDelete) => roleToDelete.name);

    if (!confirm) {
      await interaction.reply({
        content: [
          `This will permanently delete the following for **${division}**:`,
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

    for (const channel of category.children.cache.values()) {
      await channel.delete('Ratatoskr division deletion');
    }
    await category.delete('Ratatoskr division deletion');

    for (const roleToDelete of rolesToDelete) {
      await roleToDelete.delete('Ratatoskr division deletion');
    }

    await interaction.editReply(
      [
        `${division} has been permanently deleted.`,
        `Channels removed (${channelNames.length}): ${channelNames.length ? channelNames.join(', ') : 'none'}`,
        `Roles removed (${roleNames.length}): ${roleNames.length ? roleNames.join(', ') : 'none'}`,
      ].join('\n'),
    );
    return;
  }

  if (!category) {
    await interaction.reply({ content: `${division} does not have a category to archive.`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const overwrites = archiveOverwrites(interaction);
  await category.permissionOverwrites.set(overwrites, 'Ratatoskr division archive');

  for (const channel of category.children.cache.values()) {
    await channel.permissionOverwrites.set(overwrites, 'Ratatoskr division archive');
  }

  await interaction.editReply(
    `${division} has been archived. The category and history were preserved and hidden from normal division access.`,
  );
}
