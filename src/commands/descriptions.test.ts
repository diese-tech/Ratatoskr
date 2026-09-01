import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.ROLE_ALLFATHER_ID ??= 'allfather-test-role';
process.env.ROLE_AESIR_ID ??= 'aesir-test-role';

const [{ divisionCommand }, { helpCommand }, { scoutCommand }, { seasonCommand }, { serverCommand }] =
  await Promise.all([
    import('./division.js'),
    import('./help.js'),
    import('./scout.js'),
    import('./season.js'),
    import('./server.js'),
  ]);

type DescribedOption = {
  name: string;
  description: string;
  options?: DescribedOption[];
};

function asCommand(command: { toJSON(): unknown }): DescribedOption {
  return command.toJSON() as DescribedOption;
}

function child(parent: DescribedOption, name: string): DescribedOption {
  const found = parent.options?.find((option) => option.name === name);
  assert.ok(found, `${parent.name} should include ${name}`);
  return found;
}

test('every slash command, subcommand, and option uses readable English', () => {
  const help = asCommand(helpCommand);
  assert.equal(help.description, "Show a quick guide to Ratatoskr's commands.");

  const scout = asCommand(scoutCommand);
  assert.equal(scout.description, 'Create and manage preseason scouting games.');
  const scoutCreate = child(scout, 'create');
  assert.equal(scoutCreate.description, 'Set up and post a scouting game for a division.');
  assert.equal(child(scoutCreate, 'division').description, 'Division whose signup and results channels will be used.');
  const scoutCancel = child(scout, 'cancel');
  assert.equal(scoutCancel.description, 'Cancel an open scouting game for a division.');
  assert.equal(child(scoutCancel, 'division').description, 'Division whose scouting game should be cancelled.');
  const scoutConfig = child(scout, 'config');
  assert.equal(scoutConfig.description, 'Set scout staff roles, timezone, and signup emojis.');
  assert.equal(child(scoutConfig, 'timezone').description, 'Timezone used to read game times, such as America/New_York.');
  assert.equal(child(scoutConfig, 'bind_emoji').description, 'Bind five role emojis and optional Fill.');
  assert.equal(
    child(scoutConfig, 'operations_channel').description,
    'Bind the staff control channel inside the manually created Scout Operations category.',
  );

  const division = asCommand(divisionCommand);
  assert.equal(division.description, 'Create, check, archive, or delete division channels and roles.');
  assert.equal(child(division, 'add').description, 'Create missing division channels and roles, or repair existing ones.');
  assert.equal(child(child(division, 'add'), 'name').description, 'Division to create or repair.');
  assert.equal(child(division, 'status').description, 'Check which division channels and roles exist or are missing.');
  assert.equal(child(child(division, 'status'), 'name').description, 'Division to check.');
  assert.equal(child(division, 'archive').description, "Hide a division's channels without deleting its history.");
  assert.equal(child(child(division, 'archive'), 'name').description, 'Division to hide.');
  assert.equal(child(division, 'delete').description, "Permanently delete an archived division's channels and roles.");
  assert.equal(child(child(division, 'delete'), 'name').description, 'Archived division to permanently delete.');
  assert.equal(child(child(division, 'delete'), 'confirm').description, 'Choose true to confirm permanent deletion.');

  const season = asCommand(seasonCommand);
  assert.equal(season.description, 'Create and manage season channels.');
  const seasonCreate = child(season, 'create');
  assert.equal(seasonCreate.description, 'Create the channels for a new season and make it active.');
  assert.equal(child(seasonCreate, 'number').description, 'Season number, such as 2.');
  assert.equal(child(seasonCreate, 'name').description, 'Optional category name; replaces the default YSL Season N.');

  const server = asCommand(serverCommand);
  assert.equal(server.description, "Set up or repair Ratatoskr's server roles and channels.");
  const bootstrap = child(server, 'bootstrap');
  assert.equal(bootstrap.description, 'Preview or apply the standard server setup.');
  assert.equal(child(bootstrap, 'plan').description, 'Show what would change without changing anything.');
  const apply = child(bootstrap, 'apply');
  assert.equal(apply.description, 'Create or repair the standard server roles and channels.');
  assert.equal(
    child(apply, 'delete_obsolete').description,
    'Also delete old bot-managed items after they appear in the preview.',
  );
});
