import type { Client, Interaction } from 'discord.js';
import type { ApplicationStorage } from '../storage/index.js';
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

export async function handleInteraction(interaction: Interaction, storage: ApplicationStorage) {
  const db = storage.legacyDatabase;
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'scout') await handleScoutAutocomplete(interaction);
    return;
  }

  if (interaction.isRoleSelectMenu()) {
    const { handleScoutCreateRoleSelect } = await import('../services/scoutCreate.js');
    if (await handleScoutCreateRoleSelect(interaction, db)) return;
    if (await handleScoutConfigRoleSelect(interaction, db)) return;
  }

  if (interaction.isStringSelectMenu()) {
    const { handleScoutCoordinationStringSelect } = await import('../services/scoutCoordination.js');
    if (await handleScoutCoordinationStringSelect(interaction, db)) return;
    const { handleScoutCancelSelect } = await import('../services/scoutCancel.js');
    if (await handleScoutCancelSelect(interaction, db)) return;
    const { handleScoutReviewStringSelect } = await import('../services/scoutReview.js');
    if (await handleScoutReviewStringSelect(interaction, db)) return;
    const { handleScoutPublishedSlotSelect } = await import('../services/scoutPublish.js');
    if (await handleScoutPublishedSlotSelect(interaction, db)) return;
  }

  if (interaction.isUserSelectMenu()) {
    const { handleScoutCoordinationUserSelect } = await import('../services/scoutCoordination.js');
    if (await handleScoutCoordinationUserSelect(interaction, db)) return;
    const { handleScoutReviewUserSelect } = await import('../services/scoutReview.js');
    if (await handleScoutReviewUserSelect(interaction, db)) return;
    const { handleScoutPublishedUserSelect } = await import('../services/scoutPublish.js');
    if (await handleScoutPublishedUserSelect(interaction, db)) return;
  }

  if (interaction.isButton()) {
    const { handleScoutCoordinationButton } = await import('../services/scoutCoordination.js');
    if (await handleScoutCoordinationButton(interaction, db)) return;
    const { handleScoutAvailabilityButton } = await import('../services/scoutAvailability.js');
    if (await handleScoutAvailabilityButton(interaction, db)) return;
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
    const { handleScoutFinishButton } = await import('../services/scoutFinish.js');
    if (await handleScoutFinishButton(interaction, db)) return;
  }

  if (interaction.isModalSubmit()) {
    const { handleScoutCreateModal } = await import('../services/scoutCreate.js');
    if (await handleScoutCreateModal(interaction, db)) return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'division') {
    await handleDivisionCommand(interaction, storage.divisions, storage.operationScope);
  } else if (interaction.commandName === 'season') {
    await handleSeasonCommand(interaction, storage.seasons);
  } else if (interaction.commandName === 'scout') {
    await handleScoutCommand(interaction, db);
  } else if (interaction.commandName === 'server') {
    await handleServerCommand(interaction, storage.managedResources);
  } else if (interaction.commandName === 'help') {
    await handleHelpCommand(interaction);
  }
}
