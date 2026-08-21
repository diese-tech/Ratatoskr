import type { Client, Interaction } from 'discord.js';
import { divisionCommand, handleDivisionCommand } from './division.js';

export const commandData = [divisionCommand.toJSON()];

export async function registerGuildCommands(client: Client, guildId: string) {
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set(commandData);
}

export async function handleInteraction(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'division') {
    await handleDivisionCommand(interaction);
  }
}
