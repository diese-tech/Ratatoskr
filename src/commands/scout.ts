import {
  ActionRowBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type RoleSelectMenuInteraction,
} from 'discord.js';
import type Database from 'better-sqlite3';
import {
  ensureScoutConfig,
  setScoutAuthorizedRoleIds,
  setScoutTimezone,
  type ScoutConfig,
} from '../db/index.js';
import { SCOUT_ROLES, SCOUT_ROLE_LABELS } from '../domain/index.js';
import { isValidScoutTimezone, listScoutTimezones } from '../services/scoutConfig.js';

export const SCOUT_CONFIG_ROLES_CUSTOM_ID = 'scout:config:authorized_roles';

export const scoutCommand = new SlashCommandBuilder()
  .setName('scout')
  .setDescription('Manage preseason scout setups.')
  .setDMPermission(false)
  .addSubcommand((subcommand) =>
    subcommand.setName('create').setDescription('Create a scout setup in this division signup channel.'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('config')
      .setDescription('Configure scout staff, role emoji, and timezone.')
      .addStringOption((option) =>
        option
          .setName('timezone')
          .setDescription('IANA timezone, such as America/New_York.')
          .setAutocomplete(true)
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('bind_emoji')
          .setDescription('Start the public five-reaction role emoji binding flow.')
          .setRequired(false),
      ),
  );

function renderScoutConfig(config: ScoutConfig): {
  content: string;
  components: ActionRowBuilder<RoleSelectMenuBuilder>[];
} {
  const staffRoles = config.authorizedRoleIds.length
    ? config.authorizedRoleIds.map((roleId) => `<@&${roleId}>`).join(', ')
    : 'None (admins and each division\'s own captains still retain their built-in access)';
  const emoji = SCOUT_ROLES.map((role) => {
    const emojiId = config.emojiByRole[role];
    return `${SCOUT_ROLE_LABELS[role]}: ${emojiId ? `<:role:${emojiId}>` : 'not bound'}`;
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

  if (interaction.options.getBoolean('bind_emoji')) {
    const { startScoutEmojiBinding } = await import('../services/scoutEmojiBinding.js');
    await startScoutEmojiBinding(interaction);
    return;
  }

  await interaction.reply({ ...renderScoutConfig(config), flags: MessageFlags.Ephemeral });
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
