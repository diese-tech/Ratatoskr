import type { Client, Interaction } from 'discord.js';
import type Database from 'better-sqlite3';
import { divisionCommand, handleDivisionCommand } from './division.js';
import { handleHelpCommand, helpCommand } from './help.js';
import { handleSeasonCommand, seasonCommand } from './season.js';

export const commandData = [divisionCommand.toJSON(), seasonCommand.toJSON(), helpCommand.toJSON()];

export async function registerGuildCommands(client: Client, guildId: string) {
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set(commandData);
}

export async function handleInteraction(interaction: Interaction, db: Database.Database) {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'division') {
    await handleDivisionCommand(interaction);
  } else if (interaction.commandName === 'season') {
    await handleSeasonCommand(interaction, db);
  } else if (interaction.commandName === 'help') {
    await handleHelpCommand(interaction);
  }
}
