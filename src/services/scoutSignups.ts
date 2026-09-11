import type { Client, MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import type { ScoutSetup } from '../db/types.js';
import { SCOUT_SIGNUP_ROLES, SCOUT_SIGNUP_ROLE_LABELS, type ScoutSignupRole } from '../domain/index.js';
import {
  generateScoutWorkingRoster,
  type ScoutSignupRecord,
} from '../domain/scoutRoster.js';
import type { ReconcileScoutWorkingRosterOutcome, ScoutSignupStore } from '../storage/index.js';
import { eligibleScoutSignups } from './scoutEligibility.js';
import { renderPersistedScoutSignupPost } from './scoutCreate.js';
import type { OperationContext } from './operationalErrors.js';
import { withScoutSetupLock } from './scoutSetupLock.js';

export type ScoutSignupDependencies = {
  storage: ScoutSignupStore;
  operationScope: object;
  refreshStatusCard: (client: Client, setupId: number) => Promise<unknown>;
  reportError: (context: OperationContext, error: unknown) => Promise<void>;
};

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

export async function reconcileWorkingScoutRoster(
  storage: ScoutSignupStore,
  setupId: number,
  eligibleSignups: readonly ScoutSignupRecord[],
  source: 'signup' | 'startup' | 'membership' | 'refresh',
  actorUserId?: string | null,
  expectedVersion?: number,
): Promise<ReconcileScoutWorkingRosterOutcome> {
  const setup = await storage.getSetup(setupId);
  if (!setup || !['open', 'roster_ready'].includes(setup.status)) return 'stale';
  if (expectedVersion !== undefined && setup.version !== expectedVersion) return 'stale';
  const fixedSlots = (await storage.listRosterSlots(setupId))
    .filter((slot) => slot.staffAssigned)
    .map((slot) => ({
      gameNumber: slot.gameNumber,
      team: slot.team,
      role: slot.role,
      userId: slot.userId,
    }));
  const generated = generateScoutWorkingRoster(eligibleSignups, {
    gameCount: setup.gameCount,
    fixedSlots,
  });
  return storage.reconcileWorkingRoster({
    setupId,
    expectedVersion: expectedVersion ?? setup.version,
    slots: generated.slots,
    source,
    actorUserId,
  });
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

export async function reconcileActiveScoutSignups(
  client: Client,
  dependencies: ScoutSignupDependencies,
): Promise<void> {
  for (const candidate of await dependencies.storage.listActiveSetups()) {
    try {
      await withScoutSetupLock(dependencies.operationScope, candidate.id, async () => {
        const setup = await dependencies.storage.getSetup(candidate.id);
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
        const existing = await dependencies.storage.listSignups(setup.id);
        const prioritized = prioritizeObservedScoutSignups(observed, existing);
        const { accepted, rejected } = selectReconciledScoutSignups(prioritized, setup.roleLimit);
        if (!await dependencies.storage.replaceSignups(setup.id, accepted)) return;
        for (const signup of rejected) {
          await reactionsByRole.get(signup.role)?.users.remove(signup.userId).catch(async (error) => {
            await dependencies.reportError({ guildId: setup.guildId, setupId: setup.id, division: setup.divisionDisplayName, action: 'Scout excess reaction cleanup' }, error);
          });
        }

        const latestBeforeRoster = await dependencies.storage.getSetupBySignupMessageId(setup.signupMessageId);
        if (latestBeforeRoster && ['open', 'roster_ready'].includes(latestBeforeRoster.status) && message.guild) {
          const eligible = await eligibleScoutSignups(
            message.guild,
            await dependencies.storage.listSignups(setup.id),
            setup.eligibilityRoleId,
          );
          await reconcileWorkingScoutRoster(dependencies.storage, setup.id, eligible, 'startup');
        }
        const latest = await dependencies.storage.getSetupBySignupMessageId(setup.signupMessageId);
        if (latest && ['open', 'roster_ready'].includes(latest.status)) {
          await message.edit({
            content: renderPersistedScoutSignupPost(latest),
            components: [],
            allowedMentions: { parse: [] },
          }).catch(async (error) => {
            await dependencies.reportError({ guildId: setup.guildId, setupId: setup.id, division: setup.divisionDisplayName, action: 'Scout signup post recovery' }, error);
          });
        }
        if (latest) await dependencies.refreshStatusCard(client, latest.id);
      });
    } catch (error) {
      await dependencies.reportError({ guildId: candidate.guildId, setupId: candidate.id, division: candidate.divisionDisplayName, action: 'Scout signup recovery' }, error);
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

async function resolveSignupReaction(
  storage: ScoutSignupStore,
  reaction: MessageReaction,
): Promise<{ setup: ScoutSetup; role: ScoutSignupRole } | undefined> {
  const setup = await storage.getSetupBySignupMessageId(reaction.message.id);
  if (!setup || !['open', 'roster_ready'].includes(setup.status)) return undefined;
  if (reaction.message.guildId !== setup.guildId || reaction.message.channelId !== setup.signupChannelId) return undefined;
  const role = scoutRoleForEmoji(setup.emojiByRole, reaction.emoji.id);
  return role ? { setup, role } : undefined;
}

export async function handleScoutSignupReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  dependencies: ScoutSignupDependencies,
): Promise<void> {
  if (user.bot) return;
  const hydrated = await hydrateReaction(reaction, user);
  if (!hydrated || hydrated.user.bot) return;
  const resolved = await resolveSignupReaction(dependencies.storage, hydrated.reaction);
  if (!resolved) return;

  let changed = false;
  await withScoutSetupLock(dependencies.operationScope, resolved.setup.id, async () => {
    const outcome = await dependencies.storage.addSignup(resolved.setup.id, hydrated.user.id, resolved.role);
    if (outcome.status === 'added') {
      changed = true;
      const guild = hydrated.reaction.message.guild;
      if (!guild) return;
      const current = await dependencies.storage.getSetup(resolved.setup.id);
      if (!current) return;
      const signups = await eligibleScoutSignups(
        guild,
        await dependencies.storage.listSignups(resolved.setup.id),
        current.eligibilityRoleId,
      );
      const wasReady = current.status === 'roster_ready';
      await reconcileWorkingScoutRoster(dependencies.storage, resolved.setup.id, signups, 'signup', hydrated.user.id);
      const latest = await dependencies.storage.getSetupBySignupMessageId(hydrated.reaction.message.id);
      if (!wasReady && latest?.status === 'roster_ready') {
        await hydrated.reaction.message.edit({
          content: renderPersistedScoutSignupPost(latest),
          components: [],
          allowedMentions: { parse: [] },
        }).catch(async (error) => {
          await dependencies.reportError({ guildId: latest.guildId, setupId: latest.id, division: latest.divisionDisplayName, action: 'Scout signup control cleanup' }, error);
        });
      }
      return;
    }
    if (outcome.status !== 'over_limit') return;

    await hydrated.reaction.users.remove(hydrated.user.id).catch(async (error) => {
      await dependencies.reportError({ guildId: resolved.setup.guildId, setupId: resolved.setup.id, division: resolved.setup.divisionDisplayName, action: 'Scout excess reaction cleanup' }, error);
    });
    await hydrated.user
      .send(
        `You can select at most **${outcome.limit === 1 ? '1 role' : `${outcome.limit} roles`}** on that scout setup. ` +
          `Remove one of your current reactions before choosing ${SCOUT_SIGNUP_ROLE_LABELS[resolved.role]}.`,
      )
      .catch(() => undefined);
  }).finally(async () => {
    // Staff-message rate limits must not hold the signup persistence lock.
    if (changed) await dependencies.refreshStatusCard(hydrated.reaction.client, resolved.setup.id);
  });
}

export async function handleScoutSignupReactionRemove(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  dependencies: ScoutSignupDependencies,
): Promise<void> {
  if (user.bot) return;
  const hydrated = await hydrateReaction(reaction, user);
  if (!hydrated || hydrated.user.bot) return;
  const resolved = await resolveSignupReaction(dependencies.storage, hydrated.reaction);
  if (!resolved) return;
  await withScoutSetupLock(dependencies.operationScope, resolved.setup.id, async () => {
    await dependencies.storage.removeSignup(resolved.setup.id, hydrated.user.id, resolved.role);
    const current = await dependencies.storage.getSetup(resolved.setup.id);
    const guild = hydrated.reaction.message.guild;
    if (current && guild) {
      const signups = await eligibleScoutSignups(
        guild, await dependencies.storage.listSignups(current.id), current.eligibilityRoleId,
      );
      await reconcileWorkingScoutRoster(dependencies.storage, current.id, signups, 'signup', hydrated.user.id);
    }
  });
  await dependencies.refreshStatusCard(hydrated.reaction.client, resolved.setup.id);
}

/** Membership events change eligibility even when nobody adds a reaction. */
export async function refreshScoutMemberReadiness(
  client: Client,
  dependencies: ScoutSignupDependencies,
  guildId: string,
  change: { userId: string } | { eligibilityRoleId: string },
): Promise<void> {
  for (const candidate of await dependencies.storage.listActiveSetups()) {
    if (candidate.guildId !== guildId) continue;
    if ('eligibilityRoleId' in change && candidate.eligibilityRoleId !== change.eligibilityRoleId) continue;
    if ('userId' in change) {
      const [signups, slots] = await Promise.all([
        dependencies.storage.listSignups(candidate.id),
        dependencies.storage.listRosterSlots(candidate.id),
      ]);
      if (!signups.some((signup) => signup.userId === change.userId)
        && !slots.some((slot) => slot.userId === change.userId)) continue;
    }
    await withScoutSetupLock(dependencies.operationScope, candidate.id, async () => {
      try {
        const setup = await dependencies.storage.getSetup(candidate.id);
        if (setup && ['open', 'roster_ready'].includes(setup.status)) {
          const guild = await client.guilds.fetch(guildId);
          const signups = await eligibleScoutSignups(
            guild,
            await dependencies.storage.listSignups(setup.id),
            setup.eligibilityRoleId,
          );
          await reconcileWorkingScoutRoster(dependencies.storage, setup.id, signups, 'membership');
        }
      } catch (error) {
        await dependencies.reportError({ guildId, setupId: candidate.id, action: 'Scout membership readiness' }, error);
      }
    });
    await dependencies.refreshStatusCard(client, candidate.id);
  }
}
