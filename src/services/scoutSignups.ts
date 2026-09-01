import type Database from 'better-sqlite3';
import type { MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import {
  addScoutSignup,
  getScoutSetupBySignupMessageId,
  removeScoutSignup,
  listScoutSignups,
  tryCreateInitialScoutRoster,
  type ScoutSetup,
} from '../db/index.js';
import { SCOUT_SIGNUP_ROLES, SCOUT_SIGNUP_ROLE_LABELS, type ScoutSignupRole } from '../domain/index.js';
import { generateScoutRoster } from '../domain/scoutRoster.js';
import { eligibleScoutSignups } from './scoutEligibility.js';
import { scoutReviewButtonRow } from './scoutReview.js';

export function scoutRoleForEmoji(
  emojiByRole: Readonly<Record<ScoutSignupRole, string | null>>,
  emojiId: string | null,
): ScoutSignupRole | undefined {
  if (!emojiId) return undefined;
  return SCOUT_SIGNUP_ROLES.find((role) => emojiByRole[role] === emojiId);
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

  const outcome = addScoutSignup(db, resolved.setup.id, hydrated.user.id, resolved.role);
  if (outcome.status === 'added') {
    const guild = hydrated.reaction.message.guild;
    if (!guild) return;
    const signups = await eligibleScoutSignups(
      guild,
      listScoutSignups(db, resolved.setup.id),
      resolved.setup.eligibilityRoleId,
    );
    const roster = generateScoutRoster(signups);
    if (roster.feasible && tryCreateInitialScoutRoster(db, resolved.setup.id, roster.slots)) {
      await hydrated.reaction.message.edit({ components: [scoutReviewButtonRow(resolved.setup.id)] });
    }
    return;
  }
  if (outcome.status !== 'over_limit') return;

  await hydrated.reaction.users.remove(hydrated.user.id).catch((error) => {
    console.error('Could not remove over-limit scout reaction', error);
  });
  await hydrated.user
    .send(
      `You can select at most **${outcome.limit === 1 ? '1 role' : `${outcome.limit} roles`}** on that scout setup. ` +
        `Remove one of your current reactions before choosing ${SCOUT_SIGNUP_ROLE_LABELS[resolved.role]}.`,
    )
    .catch(() => undefined);
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
  removeScoutSignup(db, resolved.setup.id, hydrated.user.id, resolved.role);
}
