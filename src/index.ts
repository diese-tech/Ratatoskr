import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { handleInteraction, registerGuildCommands } from './commands/index.js';
import { env } from './config/env.js';
import { closeDatabase, openDatabase } from './db/index.js';
import { syncCaptainAccess } from './services/divisions.js';
import { tryHandleScoutEmojiBinding } from './services/scoutEmojiBinding.js';
import { handleScoutSignupReactionAdd, handleScoutSignupReactionRemove } from './services/scoutSignups.js';
import { reconcileActiveScoutSignups, refreshScoutMemberReadiness } from './services/scoutSignups.js';
import { reconcileScoutControlPanels } from './services/scoutControlPanel.js';
import { reconcileCancelledScoutSignupPosts } from './services/scoutCancel.js';
import { reconcileFinishedScoutPosts } from './services/scoutFinish.js';
import { reconcilePostingScoutSetups } from './services/scoutCreate.js';
import { reconcilePendingScoutPublishes, reconcilePendingScoutRosterUpdates } from './services/scoutPublish.js';
import { reportOperationalError } from './services/operationalErrors.js';
import { handleInteractionError } from './services/interactionErrors.js';

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
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildExpressions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
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

// Deliberately NOT a swallow-and-continue handler (Codex review on #35):
// Node 20 terminates the process by default on an unhandled rejection, and
// that default is what lets Railway notice a genuine failure -- e.g.
// client.login() below is unawaited, so a bad token or failed initial
// connection would otherwise leave the process alive but never actually
// online, invisible to any restart/alerting that keys off a process exit.
// This only makes the failure legible before that same default behavior
// takes over, it doesn't change the outcome.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  process.exit(1);
});

client.once('clientReady', async () => {
  console.log(`Ratatoskr online as ${client.user?.tag ?? 'unknown user'}`);
  await registerGuildCommands(client, env.DISCORD_GUILD_ID);
  console.log('Guild slash commands registered.');
  await reconcilePostingScoutSetups(client, db);
  console.log('Pending scout signup posts reconciled.');
  await reconcilePendingScoutPublishes(client, db);
  console.log('Pending scout publishes reconciled.');
  await reconcilePendingScoutRosterUpdates(client, db);
  console.log('Pending published roster updates reconciled.');
  await reconcileActiveScoutSignups(client, db);
  console.log('Active scout signups reconciled.');
  await reconcileCancelledScoutSignupPosts(client, db);
  console.log('Cancelled scout signup posts reconciled.');
  await reconcileFinishedScoutPosts(client, db);
  console.log('Finished scout posts reconciled.');
  await reconcileScoutControlPanels(client, db);
  console.log('Scout control panels reconciled.');
});

client.on('interactionCreate', async (interaction) => {
  try {
    await handleInteraction(interaction, db);
  } catch (error) {
    await handleInteractionError(interaction, db, error, env.DISCORD_GUILD_ID);
  }
});

client.on('guildMemberUpdate', async (_oldMember, newMember) => {
  try {
    await syncCaptainAccess(newMember);
  } catch (error) {
    console.error(`Captain access reconciliation failed for ${newMember.id}`, error);
  }
  await scoutMembershipChanged(newMember.guild.id, newMember.id);
});

async function scoutMembershipChanged(guildId: string, userId: string) {
  try { await refreshScoutMemberReadiness(client, db, guildId, { userId }); }
  catch (error) { await reportOperationalError(client, db, { guildId, action: 'Scout membership refresh' }, error); }
}

client.on('guildMemberAdd', (member) => scoutMembershipChanged(member.guild.id, member.id));
client.on('guildMemberRemove', (member) => scoutMembershipChanged(member.guild.id, member.id));
client.on('roleDelete', async (role) => {
  try { await refreshScoutMemberReadiness(client, db, role.guild.id, { eligibilityRoleId: role.id }); }
  catch (error) { await reportOperationalError(client, db, { guildId: role.guild.id, action: 'Scout eligibility role removal' }, error); }
});

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (await tryHandleScoutEmojiBinding(reaction, user, db)) return;
    await handleScoutSignupReactionAdd(reaction, user, db);
  } catch (error) {
    await reportOperationalError(client, db, { guildId: reaction.message.guildId ?? env.DISCORD_GUILD_ID, action: 'Scout signup reaction add' }, error);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    await handleScoutSignupReactionRemove(reaction, user, db);
  } catch (error) {
    await reportOperationalError(client, db, { guildId: reaction.message.guildId ?? env.DISCORD_GUILD_ID, action: 'Scout signup reaction remove' }, error);
  }
});

client.login(env.DISCORD_TOKEN);
