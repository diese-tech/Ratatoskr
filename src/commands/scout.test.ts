import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationCommandOptionType } from 'discord.js';
import { scoutCommand } from './scout.js';

test('/scout exposes create and the admin configuration surface', () => {
  const command = scoutCommand.toJSON();
  assert.equal(command.name, 'scout');

  assert.deepEqual(command.options?.map((option) => option.name), ['create', 'config']);
  const config = command.options?.find((option) => option.name === 'config');
  assert.ok(config);
  assert.equal(config.type, ApplicationCommandOptionType.Subcommand);
  if (config.type !== ApplicationCommandOptionType.Subcommand) throw new Error('config must be a subcommand');
  assert.deepEqual(
    config.options?.map((option) => option.name),
    ['timezone', 'bind_emoji'],
  );
});
