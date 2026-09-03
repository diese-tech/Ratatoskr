import {
  ActionRowBuilder,
  ChannelType,
  MessageFlags,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type RoleSelectMenuInteraction,
} from 'discord.js';
import type Database from 'better-sqlite3';
import { divisions } from '../config/guild-structure.js';
import {
  ensureScoutConfig,
  setScoutAuthorizedRoleIds,
  setScoutOperationsChannel,
  setScoutTimezone,
  type ScoutConfig,
} from '../db/index.js';
import { SCOUT_SIGNUP_ROLES, SCOUT_SIGNUP_ROLE_LABELS } from '../domain/index.js';
import { isValidScoutTimezone, listScoutTimezones } from '../services/scoutConfig.js';

export const SCOUT_CONFIG_ROLES_CUSTOM_ID = 'scout:config:authorized_roles';
const divisionChoices = divisions.map((division) => ({ name: division.name, value: division.key }));

export const scoutCommand = new SlashCommandBuilder()
  .setName('scout')
  .setDescription('Create and manage preseason scouting games.')
  .setDMPermission(false)
  .addSubcommand((subcommand) =>
    subcommand
      .setName('create')
      .setDescription('Set up and post a scouting game for a division.')
      .addStringOption((option) =>
        option
          .setName('division')
          .setDescription('Division whose signup channel will receive signups and rosters.')
          .setRequired(true)
          .addChoices(...divisionChoices),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('cancel')
      .setDescription('Choose an active scouting posting to cancel.'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('config')
      .setDescription('Set scout staff roles, timezone, and signup emojis.')
      .addStringOption((option) =>
        option
          .setName('timezone')
          .setDescription('Timezone used to read game times, such as America/New_York.')
          .setAutocomplete(true)
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('bind_emoji')
          .setDescription('Bind five role emojis and optional Fill.')
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName('operations_channel')
          .setDescription('Bind the staff control channel inside the manually created Scout Operations category.')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false),
      ),
  );

function renderScoutConfig(config: ScoutConfig): {
  content: string;
  components: ActionRowBuilder<RoleSelectMenuBuilder>[];
} {
  const staffRoles = config.authorizedRoleIds.length
    ? config.authorizedRoleIds.map((roleId) => `<@&${roleId}>`).join(', ')
    : 'None';
  const emoji = SCOUT_SIGNUP_ROLES.map((role) => {
    const emojiId = config.emojiByRole[role];
    const missing = role === 'fill' ? 'not bound (optional)' : 'not bound';
    return `${SCOUT_SIGNUP_ROLE_LABELS[role]}: ${emojiId ? `<:role:${emojiId}>` : missing}`;
  }).join('\n');

  const menu = new RoleSelectMenuBuilder()
    .setCustomId(SCOUT_CONFIG_ROLES_CUSTOM_ID)
    .setPlaceholder('Choose additional scout staff roles')
    .setMinValues(0)
    .setMaxValues(25)
    .setDefaultRoles(...config.authorizedRoleIds.slice(0, 25));

  return {
    content: [
      '**Scout configuration**',
      `Timezone: \`${config.timezone}\``,
      `Additional scout staff: ${staffRoles}`,
      'Built-in access: Allfather, Aesir, Franchise Representative, and the selected division\'s Manager and Captain.',
      `Operations channel: ${config.operationsChannelId ? `<#${config.operationsChannelId}>` : 'not bound'}`,
      '',
      emoji,
      '',
      'Division channels and captain access are managed by `/division add`.',
    ].join('\n'),
    components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu)],
  };
}

export async function handleScoutCommand(interaction: ChatInputCommandInteraction, db: Database.Database) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in the YSL server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'create') {
    const { handleScoutCreateCommand } = await import('../services/scoutCreate.js');
    await handleScoutCreateCommand(interaction, db);
    return;
  }
  if (subcommand === 'cancel') {
    const { handleScoutCancelCommand } = await import('../services/scoutCancel.js');
    await handleScoutCancelCommand(interaction, db);
    return;
  }
  if (subcommand !== 'config') return;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const { requireAccess } = await import('../services/authorization.js');
  if (!(await requireAccess(interaction, member, 'ADMIN'))) return;

  const timezone = interaction.options.getString('timezone');
  if (timezone && !isValidScoutTimezone(timezone)) {
    await interaction.reply({
      content: 'That is not a valid IANA timezone. Try a value such as `America/New_York`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let config = ensureScoutConfig(db, interaction.guild.id);
  if (timezone) config = setScoutTimezone(db, interaction.guild.id, timezone);

  const selectedOperationsChannel = interaction.options.getChannel('operations_channel');
  const operationsChannel = selectedOperationsChannel
    ? await interaction.guild.channels.fetch(selectedOperationsChannel.id)
    : null;
  if (operationsChannel) {
    if (operationsChannel.type !== ChannelType.GuildText || !operationsChannel.parentId) {
      await interaction.reply({
        content: 'The Scout Operations control channel must be a server text channel inside a category.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    config = setScoutOperationsChannel(
      db,
      interaction.guild.id,
      operationsChannel.parentId,
      operationsChannel.id,
    );
  }

  if (interaction.options.getBoolean('bind_emoji')) {
    const { startScoutEmojiBinding } = await import('../services/scoutEmojiBinding.js');
    await startScoutEmojiBinding(interaction);
    if (operationsChannel) {
      const { reconcileActiveScoutSignups } = await import('../services/scoutSignups.js');
      const { reconcileScoutControlPanels } = await import('../services/scoutControlPanel.js');
      await reconcileActiveScoutSignups(interaction.client, db);
      await reconcileScoutControlPanels(interaction.client, db);
    }
    return;
  }

  await interaction.reply({ ...renderScoutConfig(config), flags: MessageFlags.Ephemeral });
  if (operationsChannel) {
    const { reconcileActiveScoutSignups } = await import('../services/scoutSignups.js');
    const { reconcileScoutControlPanels } = await import('../services/scoutControlPanel.js');
    await reconcileActiveScoutSignups(interaction.client, db);
    await reconcileScoutControlPanels(interaction.client, db);
  }
}

export async function handleScoutConfigRoleSelect(
  interaction: RoleSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  if (interaction.customId !== SCOUT_CONFIG_ROLES_CUSTOM_ID) return false;
  if (!interaction.guild) return true;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const { hasAccess } = await import('../services/authorization.js');
  if (!hasAccess(member, 'ADMIN')) {
    await interaction.reply({ content: 'You do not have permission to change scout configuration.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const config = setScoutAuthorizedRoleIds(db, interaction.guild.id, interaction.values);
  await interaction.update(renderScoutConfig(config));
  return true;
}

export async function handleScoutAutocomplete(interaction: {
  options: { getFocused(): string };
  respond(choices: { name: string; value: string }[]): Promise<unknown>;
}) {
  const focused = interaction.options.getFocused().toLowerCase();
  const choices = listScoutTimezones()
    .filter((timezone) => timezone.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((timezone) => ({ name: timezone, value: timezone }));
  await interaction.respond(choices);
}
