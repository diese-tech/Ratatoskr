import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { env } from './config/env.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('ready', () => {
  console.log(`Ratatoskr online as ${client.user?.tag ?? 'unknown user'}`);
});

client.login(env.DISCORD_TOKEN);
