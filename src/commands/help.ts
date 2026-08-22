import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { formatHelpSections, HELP_SECTIONS } from '../services/help.js';

export const helpCommand = new SlashCommandBuilder().setName('help').setDescription('Show what Ratatoskr can do.');

export async function handleHelpCommand(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('Ratatoskr Commands')
    .setColor(0x5865f2)
    .addFields(formatHelpSections(HELP_SECTIONS));

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
