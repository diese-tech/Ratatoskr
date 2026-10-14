import type Database from 'better-sqlite3';
import type { Client, MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import { getInhouseConfig, listInhouseSubscriptions, setInhouseSubscription } from '../db/repositories/inhouse.js';

const locks = new WeakMap<object, Map<string, Promise<unknown>>>();
async function locked<T>(db: object, guildId: string, work: () => Promise<T>): Promise<T> {
  let guilds = locks.get(db);
  if (!guilds) { guilds = new Map(); locks.set(db, guilds); }
  const previous = guilds.get(guildId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  guilds.set(guildId, current);
  try { return await current; }
  finally { if (guilds.get(guildId) === current) guilds.delete(guildId); }
}

async function synchronizeRole(client: Client, db: Database.Database, guildId: string, userId: string) {
  const config = getInhouseConfig(db, guildId);
  if (!config?.roleId) throw new Error('The Inhouse role is not configured.');
  const guild = await client.guilds.fetch(guildId);
  const role = await guild.roles.fetch(config.roleId);
  // This opt-in must never become a self-service route to a privileged role.
  if (!role || role.managed || !role.editable || role.permissions.bitfield !== 0n) {
    throw new Error('The bound Inhouse role is missing, privileged, or above Ratatoskr. Restore the ordinary opt-in role.');
  }
  const member = await guild.members.fetch({ user: userId, force: true }).catch((error: unknown) => {
    if (Number((error as { code?: number })?.code) === 10007) return undefined;
    throw error;
  });
  const desired = listInhouseSubscriptions(db, guildId).find(row => row.userId === userId);
  if (!desired?.pending) return;
  if (member && !member.user.bot) {
    if (desired.subscribed && !member.roles.cache.has(role.id)) await member.roles.add(role.id, 'Inhouse reaction opt-in');
    if (!desired.subscribed && member.roles.cache.has(role.id)) await member.roles.remove(role.id, 'Inhouse reaction opt-out');
  }
  db.prepare(`UPDATE inhouse_subscriptions SET pending=0,next_attempt_at=0
    WHERE guild_id=? AND user_id=? AND revision=?`).run(guildId, userId, desired.revision);
}

export async function handleInhouseRoleReaction(client: Client, db: Database.Database,
  reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, subscribed: boolean): Promise<boolean> {
  if (user.bot || !reaction.message.guildId) return false;
  const config = getInhouseConfig(db, reaction.message.guildId);
  if (!config?.messageId || !config.roleId || !config.channelId
    || reaction.message.id !== config.messageId || reaction.message.channelId !== config.channelId
    || reaction.emoji.id !== null || reaction.emoji.name !== config.emoji) return false;
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  if (message.author.id !== client.user?.id) throw new Error('The Inhouse opt-in message is not owned by Ratatoskr.');
  setInhouseSubscription(db, config.guildId, user.id, subscribed);
  await locked(db, config.guildId, async () => {
    try { await synchronizeRole(client, db, config.guildId, user.id); }
    catch (error) {
      db.prepare('UPDATE inhouse_subscriptions SET next_attempt_at=? WHERE guild_id=? AND user_id=?')
        .run(Date.now() + 60_000, config.guildId, user.id);
      throw error;
    }
  });
  return true;
}

/** Bounded targeted recovery; never fetches the full server membership. */
export async function retryInhouseRoles(client: Client, db: Database.Database, guildId: string,
  report: (error: unknown) => Promise<void>): Promise<void> {
  await locked(db, guildId, async () => {
    const pending = listInhouseSubscriptions(db, guildId)
      .filter(row => row.pending && row.nextAttemptAt <= Date.now())
      // A backed-off member must not be first forever once its cooldown ends.
      // Unattempted and older pending changes get their own bounded turn.
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.userId.localeCompare(b.userId)).slice(0, 25);
    for (const row of pending) {
      try { await synchronizeRole(client, db, guildId, row.userId); }
      catch (error) {
        db.prepare('UPDATE inhouse_subscriptions SET next_attempt_at=? WHERE guild_id=? AND user_id=?')
          .run(Date.now() + 60_000, guildId, row.userId);
        await report(error);
        break;
      }
    }
  });
}

/** Reconcile reactions changed while Ratatoskr was offline; no polling of Sheets. */
export async function reconcileInhouseRoles(client: Client, db: Database.Database, guildId: string,
  report: (error: unknown) => Promise<void>): Promise<void> {
  const config = getInhouseConfig(db, guildId);
  if (!config?.messageId || !config.channelId || !config.roleId) return;
  const channelId = config.channelId;
  await locked(db, guildId, async () => {
    const revision = () => listInhouseSubscriptions(db, guildId).reduce((total, row) => total + row.revision, 0);
    const beforeRevision = revision();
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !('guildId' in channel) || channel.guildId !== guildId) throw new Error('Inhouse channel is unavailable.');
    const message = await channel.messages.fetch(config.messageId!);
    if (message.author.id !== client.user?.id) throw new Error('Inhouse opt-in message ownership changed.');
    await message.react(config.emoji);
    const reaction = message.reactions.cache.get(config.emoji);
    if (!reaction) throw new Error('Inhouse opt-in reaction could not be verified. No role removals were attempted.');
    const observed = new Set<string>();
    let after: string | undefined;
    while (true) {
      const page = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
      for (const user of page.values()) if (!user.bot) observed.add(user.id);
      if (page.size < 100) break;
      const next = page.last()?.id;
      if (!next || next === after) throw new Error('Inhouse reaction pagination did not complete.');
      after = next;
    }
    // Live reaction events already persisted their newer intent while this read
    // was running. Do not replace it with an older startup observation.
    if (revision() !== beforeRevision) return;
    const existing = new Map(listInhouseSubscriptions(db, guildId).map(row => [row.userId, row]));
    for (const id of new Set([...observed, ...existing.keys()])) {
      const subscribed = observed.has(id);
      if (!existing.has(id) || Boolean(existing.get(id)!.subscribed) !== subscribed) {
        setInhouseSubscription(db, guildId, id, subscribed);
      }
    }
  });
  await retryInhouseRoles(client, db, guildId, report);
}

export function startInhouseRoleWorker(client: Client, db: Database.Database, guildId: string,
  report: (error: unknown) => Promise<void>): () => void {
  let running = false, nextObservation = Date.now() + 60 * 60_000;
  const timer = setInterval(() => {
    if (running || !getInhouseConfig(db, guildId)?.messageId) return;
    running = true;
    const work = Date.now() >= nextObservation
      ? reconcileInhouseRoles(client, db, guildId, report)
      : retryInhouseRoles(client, db, guildId, report);
    if (Date.now() >= nextObservation) nextObservation = Date.now() + 60 * 60_000;
    void work.catch(report).catch(() => console.error('Inhouse role recovery could not report its failure.'))
      .finally(() => { running = false; });
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
