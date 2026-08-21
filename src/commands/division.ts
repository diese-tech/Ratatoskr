import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Role,
} from 'discord.js';
import { divisions, type DivisionName } from '../config/guild-structure.js';
import { provisionDivision } from '../services/divisions.js';

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

function canManageDivisions(member: GuildMember) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some((role) => role.name === 'Allfather' || role.name === 'Æsir');
}

function isCategoryArchived(category: CategoryChannel) {
  const everyoneOverwrite = category.permissionOverwrites.cache.get(category.guild.roles.everyone.id);
  return everyoneOverwrite?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;
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
  if (!canManageDivisions(member)) {
    await interaction.reply({ content: 'You do not have permission to manage divisions.', flags: MessageFlags.Ephemeral });
    return;
  }

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
    const expectedChannels = [
      `${division.toLowerCase().replace(/\s+/g, '-')}-announcements`,
      'general',
      'scheduling',
      'match-reports',
      'captain-chat',
      `${division} Lobby`,
    ];
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

    if (!isCategoryArchived(category)) {
      await interaction.reply({
        content: `${division} must be archived with \`/division archive\` before it can be deleted.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!confirm) {
      await interaction.reply({
        content: `Pass \`confirm: true\` to permanently delete ${division}'s archived category, channels, and roles. This cannot be undone.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const deletedChannels: string[] = [];
    for (const channel of category.children.cache.values()) {
      deletedChannels.push(channel.name);
      await channel.delete('Ratatoskr division deletion');
    }
    await category.delete('Ratatoskr division deletion');

    const captainRole = interaction.guild.roles.cache.find(
      (candidate) => candidate.name === `${division} Captain Access`,
    );
    const deletedRoles: string[] = [];
    for (const roleToDelete of [role, captainRole].filter((candidate): candidate is Role => Boolean(candidate))) {
      deletedRoles.push(roleToDelete.name);
      await roleToDelete.delete('Ratatoskr division deletion');
    }

    await interaction.editReply(
      `${division} has been permanently deleted.\nChannels removed: ${deletedChannels.length}\nRoles removed: ${deletedRoles.length}`,
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
