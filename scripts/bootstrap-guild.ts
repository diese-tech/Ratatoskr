import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { env } from '../src/config/env.js';
import { runServerBootstrap } from '../src/services/serverBootstrapRunner.js';
import { openApplicationStorage } from '../src/storage/index.js';

const apply = process.argv.includes('--apply');
const deleteObsolete = process.argv.includes('--delete-obsolete');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function bootstrap() {
  const storage = openApplicationStorage();

  try {
    await client.login(env.DISCORD_TOKEN);
    const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);

    await runServerBootstrap(storage.managedResources, guild, { apply, deleteObsolete }, (line) => console.log(line));
  } finally {
    await storage.close();
    await client.destroy();
  }
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
