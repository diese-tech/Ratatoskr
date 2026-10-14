import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type Database from 'better-sqlite3';
import { handleInhouseCreateCommand } from '../services/scoutCreate.js';
import { handleScoutCancelCommand } from '../services/scoutCancel.js';

export const inhouseCommand = new SlashCommandBuilder().setName('inhouse')
  .setDescription('Host optional open inhouse games.').setDMPermission(false)
  .addSubcommand(s => s.setName('create').setDescription('Post an open inhouse; the Inhouse role is required to host.'))
  .addSubcommand(s => s.setName('cancel').setDescription('Choose one of your open inhouses to cancel.'));

export async function handleInhouseCommand(interaction: ChatInputCommandInteraction, db: Database.Database) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Inhouses are only available in the league server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.options.getSubcommand() === 'create') await handleInhouseCreateCommand(interaction, db);
  else await handleScoutCancelCommand(interaction, db, 'inhouse');
}
