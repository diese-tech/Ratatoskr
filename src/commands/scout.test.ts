import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationCommandOptionType } from 'discord.js';
import { scoutCommand } from './scout.js';

test('/scout exposes create, cancel, and the admin configuration surface', () => {
  const command = scoutCommand.toJSON();
  assert.equal(command.name, 'scout');

  assert.deepEqual(command.options?.map((option) => option.name), ['create', 'cancel', 'config']);
  for (const subcommandName of ['create']) {
    const subcommand: any = command.options?.find((option) => option.name === subcommandName);
    assert.ok(subcommand && subcommand.type === ApplicationCommandOptionType.Subcommand);
    if (subcommand.type !== ApplicationCommandOptionType.Subcommand) throw new Error(`${subcommandName} must be a subcommand`);
    assert.deepEqual(subcommand.options?.map((option: { name: string }) => option.name), ['division']);
    assert.equal(subcommand.options?.[0]?.required, true);
  }
  const cancel: any = command.options?.find((option) => option.name === 'cancel');
  assert.deepEqual(cancel.options ?? [], [], 'cancel must not require a division');
  const config = command.options?.find((option) => option.name === 'config');
  assert.ok(config);
  assert.equal(config.type, ApplicationCommandOptionType.Subcommand);
  if (config.type !== ApplicationCommandOptionType.Subcommand) throw new Error('config must be a subcommand');
  assert.deepEqual(
    config.options?.map((option) => option.name),
    ['timezone', 'bind_emoji', 'operations_channel'],
  );
});
