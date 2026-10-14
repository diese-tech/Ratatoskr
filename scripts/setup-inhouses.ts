import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { setupInhouses } from '../src/services/inhouseSetup.js';
import { reconcileInhouseRoles } from '../src/services/inhouseRoles.js';

const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const required = (name: string) => { const value = arg(name); if (!value) throw new Error(`Supply --${name}.`); return value; };
async function main() {
  const guildId = required('expect-guild-id');
  if (guildId !== process.env.DISCORD_GUILD_ID) throw new Error('Expected guild differs from the configured league.');
  if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) throw new Error('Use the existing authorized bot service context.');
  const input = { guildId, categoryId: required('category-id'), categoryName: required('category-name'),
    roleName: required('role-name'), channelName: required('channel-name'), emoji: required('emoji') };
  const write = process.argv.includes('--write');
  const databasePath = required('expect-database-path');
  if (!process.env.DATABASE_PATH || resolve(databasePath) !== resolve(process.env.DATABASE_PATH)) {
    throw new Error('Expected persistent database differs from the configured service.');
  }
  if (required('expect-commit') !== process.env.RAILWAY_GIT_COMMIT_SHA) throw new Error('Unexpected deployed commit.');
  const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { retries: 0 } });
  // Operator preflight must never create a database or apply migrations.
  const db = new Database(databasePath, { readonly: !write, fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    if (!db.prepare('SELECT id FROM schema_migrations WHERE id = 35').get()) {
      throw new Error('Deploy the reviewed inhouse migration before running setup.');
    }
    await client.login(process.env.DISCORD_TOKEN);
    if (client.user?.id !== process.env.DISCORD_CLIENT_ID) throw new Error('Unexpected bot identity.');
    const guild = await client.guilds.fetch(guildId);
    console.log(JSON.stringify(await setupInhouses(guild, db, input, {
      write, expectedPlan: arg('expect-plan'),
    })));
    if (write) await reconcileInhouseRoles(client, db, guildId, async () => {
      throw new Error('Opt-in reconciliation remains pending for the running bot.');
    });
  } finally { client.destroy(); db.close(); }
}
main().catch(() => { console.error('Inhouse setup stopped. Inspect the approved targets and durable bindings; do not replay an ambiguous create blindly.'); process.exitCode = 1; });
