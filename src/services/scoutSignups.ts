import { reportOperationalError } from './operationalErrors.js';
import type Database from 'better-sqlite3';
import type { Client, MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import {
  addScoutSignup,
  getScoutSetupById,
  getScoutSetupBySignupMessageId,
  listActiveScoutSetups,
  removeScoutSignup,
  listScoutSignups,
  listScoutRosterSlots,
  replaceScoutSignups,
  tryCreateInitialScoutRoster,
  type ScoutSetup,
} from '../db/index.js';
import { SCOUT_SIGNUP_ROLES, SCOUT_SIGNUP_ROLE_LABELS, type ScoutSignupRole } from '../domain/index.js';
import { generateScoutRoster } from '../domain/scoutRoster.js';
import { eligibleScoutSignups } from './scoutEligibility.js';
import { refreshScoutStatusCardSafely } from './scoutCardLifecycle.js';
import { renderPersistedScoutSignupPost } from './scoutCreate.js';

const setupLocksByDatabase = new WeakMap<Database.Database, Map<number, Promise<void>>>();

async function withScoutSetupLock<T>(db: Database.Database, setupId: number, task: () => Promise<T>): Promise<T> {
  let setupLocks = setupLocksByDatabase.get(db);
  if (!setupLocks) { setupLocks = new Map(); setupLocksByDatabase.set(db, setupLocks); }
  const previous = setupLocks.get(setupId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  setupLocks.set(setupId, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (setupLocks.get(setupId) === tail) setupLocks.delete(setupId);
  }
}

export function scoutRoleForEmoji(
  emojiByRole: Readonly<Record<ScoutSignupRole, string | null>>,
  emojiId: string | null,
): ScoutSignupRole | undefined {
  if (!emojiId) return undefined;
  return SCOUT_SIGNUP_ROLES.find((role) => emojiByRole[role] === emojiId);
}

export function selectReconciledScoutSignups(
  observed: readonly { userId: string; role: ScoutSignupRole }[],
  roleLimit: number,
): {
  accepted: { userId: string; role: ScoutSignupRole }[];
  rejected: { userId: string; role: ScoutSignupRole }[];
} {
  const accepted: { userId: string; role: ScoutSignupRole }[] = [];
  const rejected: { userId: string; role: ScoutSignupRole }[] = [];
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const signup of observed) {
    const key = `${signup.userId}:${signup.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const count = counts.get(signup.userId) ?? 0;
    if (count >= roleLimit) rejected.push(signup);
    else {
      accepted.push(signup);
      counts.set(signup.userId, count + 1);
    }
  }
  return { accepted, rejected };
}

export function prioritizeObservedScoutSignups(
  observed: readonly { userId: string; role: ScoutSignupRole }[],
  existing: readonly { userId: string; role: ScoutSignupRole }[],
): { userId: string; role: ScoutSignupRole }[] {
  const observedByKey = new Map(observed.map((signup) => [`${signup.userId}:${signup.role}`, signup]));
  const prioritized = existing
    .map((signup) => observedByKey.get(`${signup.userId}:${signup.role}`))
    .filter((signup): signup is { userId: string; role: ScoutSignupRole } => Boolean(signup));
  const existingKeys = new Set(prioritized.map((signup) => `${signup.userId}:${signup.role}`));
  prioritized.push(...observed.filter((signup) => !existingKeys.has(`${signup.userId}:${signup.role}`)));
  return prioritized;
}

async function fetchReactionUsers(reaction: MessageReaction): Promise<User[]> {
  const users: User[] = [];
  let after: string | undefined;
  while (true) {
    const page = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
    const values = [...page.values()];
    users.push(...values);
    if (values.length < 100) return users;
    after = values.at(-1)!.id;
  }
}

export async function reconcileActiveScoutSignups(client: Client, db: Database.Database): Promise<void> {
  for (const candidate of listActiveScoutSetups(db)) {
    try {
      await withScoutSetupLock(db, candidate.id, async () => {
        const setup = getScoutSetupById(db, candidate.id);
        if (!setup || !['open', 'roster_ready'].includes(setup.status) || !setup.signupMessageId) return;
        const channel = await client.channels.fetch(setup.signupChannelId);
        if (!channel?.isTextBased()) throw new Error('Signup post is unavailable.');
        const message = await channel.messages.fetch(setup.signupMessageId);
        const observed: { userId: string; role: ScoutSignupRole }[] = [];
        const reactionsByRole = new Map<ScoutSignupRole, MessageReaction>();
        for (const role of SCOUT_SIGNUP_ROLES) {
          const emojiId = setup.emojiByRole[role];
          if (!emojiId) continue;
          const reaction = message.reactions.cache.get(emojiId);
          if (!reaction) continue;
          reactionsByRole.set(role, reaction);
          for (const user of await fetchReactionUsers(reaction)) {
            if (!user.bot) observed.push({ userId: user.id, role });
          }
        }
        const existing = listScoutSignups(db, setup.id);
        const prioritized = prioritizeObservedScoutSignups(observed, existing);
        const { accepted, rejected } = selectReconciledScoutSignups(prioritized, setup.roleLimit);
        if (!replaceScoutSignups(db, setup.id, accepted)) return;
        for (const signup of rejected) {
          await reactionsByRole.get(signup.role)?.users.remove(signup.userId).catch(async (error) => {
            await reportOperationalError(client, db, { guildId: setup.guildId, setupId: setup.id, division: setup.divisionDisplayName, action: 'Scout excess reaction cleanup' }, error);
          });
        }

        const latestBeforeRoster = getScoutSetupBySignupMessageId(db, setup.signupMessageId);
        if (latestBeforeRoster?.status === 'open' && message.guild) {
          const eligible = await eligibleScoutSignups(
            message.guild,
            listScoutSignups(db, setup.id),
            setup.eligibilityRoleId,
          );
          const roster = generateScoutRoster(eligible);
          if (roster.feasible) tryCreateInitialScoutRoster(db, setup.id, roster.slots);
        }
        const latest = getScoutSetupBySignupMessageId(db, setup.signupMessageId);
        if (latest && ['open', 'roster_ready'].includes(latest.status)) {
          await message.edit({
            content: renderPersistedScoutSignupPost(latest),
            components: [],
            allowedMentions: { parse: [] },
          }).catch(async (error) => {
            await reportOperationalError(client, db, { guildId: setup.guildId, setupId: setup.id, division: setup.divisionDisplayName, action: 'Scout signup post recovery' }, error);
          });
        }
        if (latest) await refreshScoutStatusCardSafely(client, db, latest.id);
      });
    } catch (error) {
      await reportOperationalError(client, db, { guildId: candidate.guildId, setupId: candidate.id, division: candidate.divisionDisplayName, action: 'Scout signup recovery' }, error);
    }
  }
}

async function hydrateReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<{ reaction: MessageReaction; user: User } | undefined> {
  try {
    const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
    const fullUser = user.partial ? await user.fetch() : user;
    return { reaction: fullReaction, user: fullUser };
  } catch {
    return undefined;
  }
}

function resolveSignupReaction(
  db: Database.Database,
  reaction: MessageReaction,
): { setup: ScoutSetup; role: ScoutSignupRole } | undefined {
  const setup = getScoutSetupBySignupMessageId(db, reaction.message.id);
  if (!setup || !['open', 'roster_ready'].includes(setup.status)) return undefined;
  if (reaction.message.guildId !== setup.guildId || reaction.message.channelId !== setup.signupChannelId) return undefined;
  const role = scoutRoleForEmoji(setup.emojiByRole, reaction.emoji.id);
  return role ? { setup, role } : undefined;
}

export async function handleScoutSignupReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  db: Database.Database,
): Promise<void> {
  if (user.bot) return;
  const hydrated = await hydrateReaction(reaction, user);
  if (!hydrated || hydrated.user.bot) return;
  const resolved = resolveSignupReaction(db, hydrated.reaction);
  if (!resolved) return;

  await withScoutSetupLock(db, resolved.setup.id, async () => {
    const outcome = addScoutSignup(db, resolved.setup.id, hydrated.user.id, resolved.role);
    if (outcome.status === 'added') {
      const guild = hydrated.reaction.message.guild;
      if (!guild) return;
      const current = getScoutSetupById(db, resolved.setup.id);
      if (!current) return;
      const signups = await eligibleScoutSignups(
        guild,
        listScoutSignups(db, resolved.setup.id),
        current.eligibilityRoleId,
      );
      const roster = generateScoutRoster(signups);
      const becameReady = roster.feasible && tryCreateInitialScoutRoster(db, resolved.setup.id, roster.slots);
      const latest = getScoutSetupBySignupMessageId(db, hydrated.reaction.message.id);
      if (becameReady && latest?.status === 'roster_ready') {
        await hydrated.reaction.message.edit({
          content: renderPersistedScoutSignupPost(latest),
          components: [],
          allowedMentions: { parse: [] },
        }).catch(async (error) => {
          await reportOperationalError(hydrated.reaction.client, db, { guildId: latest.guildId, setupId: latest.id, division: latest.divisionDisplayName, action: 'Scout signup control cleanup' }, error);
        });
      }
      await refreshScoutStatusCardSafely(hydrated.reaction.client, db, current.id);
      return;
    }
    if (outcome.status !== 'over_limit') return;

    await hydrated.reaction.users.remove(hydrated.user.id).catch(async (error) => {
      await reportOperationalError(hydrated.reaction.client, db, { guildId: resolved.setup.guildId, setupId: resolved.setup.id, division: resolved.setup.divisionDisplayName, action: 'Scout excess reaction cleanup' }, error);
    });
    await hydrated.user
      .send(
        `You can select at most **${outcome.limit === 1 ? '1 role' : `${outcome.limit} roles`}** on that scout setup. ` +
          `Remove one of your current reactions before choosing ${SCOUT_SIGNUP_ROLE_LABELS[resolved.role]}.`,
      )
      .catch(() => undefined);
  });
}

export async function handleScoutSignupReactionRemove(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  db: Database.Database,
): Promise<void> {
  if (user.bot) return;
  const hydrated = await hydrateReaction(reaction, user);
  if (!hydrated || hydrated.user.bot) return;
  const resolved = resolveSignupReaction(db, hydrated.reaction);
  if (!resolved) return;
  await withScoutSetupLock(db, resolved.setup.id, async () => {
    removeScoutSignup(db, resolved.setup.id, hydrated.user.id, resolved.role);
    await refreshScoutStatusCardSafely(hydrated.reaction.client, db, resolved.setup.id);
  });
}

/** Membership events change eligibility even when nobody adds a reaction. */
export async function refreshScoutMemberReadiness(client: Client, db: Database.Database, guildId: string,
  change: { userId: string } | { eligibilityRoleId: string }): Promise<void> {
  for (const candidate of listActiveScoutSetups(db)) {
    if (candidate.guildId !== guildId) continue;
    if ('eligibilityRoleId' in change && candidate.eligibilityRoleId !== change.eligibilityRoleId) continue;
    if ('userId' in change && !listScoutSignups(db, candidate.id).some((signup) => signup.userId === change.userId)
      && !listScoutRosterSlots(db, candidate.id).some((slot) => slot.userId === change.userId)) continue;
    await withScoutSetupLock(db, candidate.id, async () => {
      try {
        const setup = getScoutSetupById(db, candidate.id);
        if (setup?.status === 'open') {
          const guild = await client.guilds.fetch(guildId);
          const signups = await eligibleScoutSignups(guild, listScoutSignups(db, setup.id), setup.eligibilityRoleId);
          const generated = generateScoutRoster(signups);
          if (generated.feasible) tryCreateInitialScoutRoster(db, setup.id, generated.slots);
        }
      } catch (error) {
        await reportOperationalError(client, db, { guildId, setupId: candidate.id, action: 'Scout membership readiness' }, error);
      }
      await refreshScoutStatusCardSafely(client, db, candidate.id);
    });
  }
}
