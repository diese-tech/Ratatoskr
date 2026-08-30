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

// Backstop, not the fix itself: discord.js constructs Client with
// captureRejections, so a rejection escaping any async event listener
// becomes a Client 'error' event rather than a bare unhandled rejection --
// and an 'error' event with no listener is rethrown by Node, killing the
// process. Every listener below already catches its own errors, but this
// still logs rather than crashes if a future listener (or a discord.js
// internal path) doesn't (#34).
client.on('error', (error) => console.error('Discord client error:', error));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

client.once('clientReady', async () => {
  console.log(`Ratatoskr online as ${client.user?.tag ?? 'unknown user'}`);
  await registerGuildCommands(client, env.DISCORD_GUILD_ID);
  console.log('Guild slash commands registered.');
});

client.on('interactionCreate', async (interaction) => {
  try {
    await handleInteraction(interaction, db);
  } catch (error) {
    console.error('Interaction failed', error);
    if (interaction.isRepliable()) {
      const payload = { content: 'Ratatoskr could not complete that command. Check staff logs for details.', flags: MessageFlags.Ephemeral } as const;
      // Best-effort: the interaction token can already be dead here (the
      // 3-second window elapsed, or a partial reply already happened),
      // which makes this apology reply itself throw. Since captureRejections
      // turns that into a Client 'error' event, an uncaught one here takes
      // the whole process down over a single failed command -- swallow it
      // rather than let the cure be worse than the disease (#34).
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => undefined);
      else await interaction.reply(payload).catch(() => undefined);
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
