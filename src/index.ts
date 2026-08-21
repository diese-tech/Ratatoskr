import 'dotenv/config';
import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import { handleInteraction, registerGuildCommands } from './commands/index.js';
import { env } from './config/env.js';
import { closeDatabase, openDatabase } from './db/index.js';
import { syncCaptainAccess } from './services/divisions.js';

// Opened before login: a database that can't be opened/migrated fails
// startup immediately rather than letting the bot come online without
// durable storage.
const db = openDatabase();
console.log('Database ready.');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

async function shutdown() {
  await client.destroy();
  closeDatabase(db);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.once('clientReady', async () => {
  console.log(`Ratatoskr online as ${client.user?.tag ?? 'unknown user'}`);
  await registerGuildCommands(client, env.DISCORD_GUILD_ID);
  console.log('Guild slash commands registered.');
});

client.on('interactionCreate', async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (error) {
    console.error('Interaction failed', error);
    if (interaction.isRepliable()) {
      const payload = { content: 'Ratatoskr could not complete that command. Check staff logs for details.', flags: MessageFlags.Ephemeral } as const;
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    }
  }
});

client.on('guildMemberUpdate', async (_oldMember, newMember) => {
  try {
    await syncCaptainAccess(newMember);
  } catch (error) {
    console.error(`Captain access reconciliation failed for ${newMember.id}`, error);
  }
});

client.login(env.DISCORD_TOKEN);
