import type { Client, Interaction } from 'discord.js';
import type Database from 'better-sqlite3';
import { divisionCommand, handleDivisionCommand } from './division.js';
import { handleHelpCommand, helpCommand } from './help.js';
import {
  handleScoutAutocomplete,
  handleScoutCommand,
  handleScoutConfigRoleSelect,
  scoutCommand,
} from './scout.js';
import { handleSeasonCommand, seasonCommand } from './season.js';
import { handleServerCommand, serverCommand } from './server.js';

export const commandData = [
  divisionCommand.toJSON(),
  seasonCommand.toJSON(),
  scoutCommand.toJSON(),
  serverCommand.toJSON(),
  helpCommand.toJSON(),
];

export async function registerGuildCommands(client: Client, guildId: string) {
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set(commandData);
}

export async function handleInteraction(interaction: Interaction, db: Database.Database) {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'scout') await handleScoutAutocomplete(interaction);
    return;
  }

  if (interaction.isRoleSelectMenu()) {
    if (await handleScoutConfigRoleSelect(interaction, db)) return;
  }

  if (interaction.isStringSelectMenu()) {
    const { handleScoutCancelSelect } = await import('../services/scoutCancel.js');
    if (await handleScoutCancelSelect(interaction, db)) return;
    const { handleScoutReviewStringSelect } = await import('../services/scoutReview.js');
    if (await handleScoutReviewStringSelect(interaction, db)) return;
    const { handleScoutPublishedSlotSelect } = await import('../services/scoutPublish.js');
    if (await handleScoutPublishedSlotSelect(interaction, db)) return;
  }

  if (interaction.isUserSelectMenu()) {
    const { handleScoutReviewUserSelect } = await import('../services/scoutReview.js');
    if (await handleScoutReviewUserSelect(interaction, db)) return;
    const { handleScoutPublishedUserSelect } = await import('../services/scoutPublish.js');
    if (await handleScoutPublishedUserSelect(interaction, db)) return;
  }

  if (interaction.isButton()) {
    const { handleScoutFillSkipButton } = await import('../services/scoutEmojiBinding.js');
    if (await handleScoutFillSkipButton(interaction, db)) return;
    const { handleScoutCreateButton } = await import('../services/scoutCreate.js');
    if (await handleScoutCreateButton(interaction, db)) return;
    const { handleScoutReviewButton } = await import('../services/scoutReview.js');
    if (await handleScoutReviewButton(interaction, db)) return;
    const { handleScoutPublishButton } = await import('../services/scoutPublish.js');
    if (await handleScoutPublishButton(interaction, db)) return;
    const { handleScoutCancelButton } = await import('../services/scoutCancel.js');
    if (await handleScoutCancelButton(interaction, db)) return;
  }

  if (interaction.isModalSubmit()) {
    const { handleScoutCreateModal } = await import('../services/scoutCreate.js');
    if (await handleScoutCreateModal(interaction, db)) return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'division') {
    await handleDivisionCommand(interaction, db);
  } else if (interaction.commandName === 'season') {
    await handleSeasonCommand(interaction, db);
  } else if (interaction.commandName === 'scout') {
    await handleScoutCommand(interaction, db);
  } else if (interaction.commandName === 'server') {
    await handleServerCommand(interaction, db);
  } else if (interaction.commandName === 'help') {
    await handleHelpCommand(interaction);
  }
}
