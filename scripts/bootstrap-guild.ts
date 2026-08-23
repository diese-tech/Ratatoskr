import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { env } from '../src/config/env.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { runServerBootstrap } from '../src/services/serverBootstrapRunner.js';

const apply = process.argv.includes('--apply');
const deleteObsolete = process.argv.includes('--delete-obsolete');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function bootstrap() {
  const db = openDatabase();

  try {
    await client.login(env.DISCORD_TOKEN);
    const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);

    await runServerBootstrap(db, guild, { apply, deleteObsolete }, (line) => console.log(line));
  } finally {
    closeDatabase(db);
    await client.destroy();
  }
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
