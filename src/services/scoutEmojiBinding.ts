import type Database from 'better-sqlite3';
import type {
  ChatInputCommandInteraction,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from 'discord.js';
import { setScoutEmojiByRole } from '../db/index.js';
import { SCOUT_ROLES, SCOUT_ROLE_LABELS, type ScoutRole } from '../domain/index.js';

const BINDING_TTL_MS = 15 * 60 * 1_000;

export type ScoutEmojiBindingState = {
  guildId: string;
  userId: string;
  emojiIds: readonly string[];
};

type BindingInput = {
  userId: string;
  emojiId: string | null;
  guildEmojiIds: ReadonlySet<string>;
};

type BindingResult = {
  outcome: 'ignored-user' | 'invalid-standard' | 'invalid-guild' | 'duplicate' | 'progress' | 'complete';
  state: ScoutEmojiBindingState;
  emojiByRole?: Record<ScoutRole, string>;
};

type LiveBinding = {
  state: ScoutEmojiBindingState;
  expiresAt: number;
};

const liveBindings = new Map<string, LiveBinding>();

export function createScoutEmojiBindingState(guildId: string, userId: string): ScoutEmojiBindingState {
  return { guildId, userId, emojiIds: [] };
}

function completedEmojiMap(emojiIds: readonly string[]): Record<ScoutRole, string> {
  return Object.fromEntries(SCOUT_ROLES.map((role, index) => [role, emojiIds[index]])) as Record<ScoutRole, string>;
}

export function advanceScoutEmojiBinding(state: ScoutEmojiBindingState, input: BindingInput): BindingResult {
  if (state.emojiIds.length === SCOUT_ROLES.length) {
    return { outcome: 'complete', state, emojiByRole: completedEmojiMap(state.emojiIds) };
  }
  if (input.userId !== state.userId) return { outcome: 'ignored-user', state };
  if (!input.emojiId) return { outcome: 'invalid-standard', state };
  if (!input.guildEmojiIds.has(input.emojiId)) return { outcome: 'invalid-guild', state };
  if (state.emojiIds.includes(input.emojiId)) return { outcome: 'duplicate', state };

  const nextState = { ...state, emojiIds: [...state.emojiIds, input.emojiId] };
  if (nextState.emojiIds.length === SCOUT_ROLES.length) {
    return { outcome: 'complete', state: nextState, emojiByRole: completedEmojiMap(nextState.emojiIds) };
  }
  return { outcome: 'progress', state: nextState };
}

function bindingMessage(state: ScoutEmojiBindingState, warning?: string): string {
  const assigned = state.emojiIds.map((emojiId, index) => `${SCOUT_ROLE_LABELS[SCOUT_ROLES[index]!]}: <:role:${emojiId}>`);
  const nextRole = SCOUT_ROLES[state.emojiIds.length];
  return [
    '**Scout role emoji binding**',
    `Only <@${state.userId}> can complete this binding. It expires in 15 minutes.`,
    warning ? `⚠️ ${warning}` : undefined,
    assigned.length ? assigned.join('\n') : undefined,
    nextRole ? `React to this message with this server's custom emoji for **${SCOUT_ROLE_LABELS[nextRole]}**.` : undefined,
    'Order: Solo → Jungle → Mid → Support → Carry.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function startScoutEmojiBinding(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;

  const state = createScoutEmojiBindingState(interaction.guild.id, interaction.user.id);
  await interaction.reply({ content: bindingMessage(state) });
  const message = await interaction.fetchReply();
  liveBindings.set(message.id, { state, expiresAt: Date.now() + BINDING_TTL_MS });

  setTimeout(() => {
    const binding = liveBindings.get(message.id);
    if (!binding || binding.expiresAt > Date.now()) return;
    liveBindings.delete(message.id);
    void message.edit('Scout role emoji binding expired. Run `/scout config bind_emoji:true` to start again.').catch(() => undefined);
  }, BINDING_TTL_MS).unref();
}

export async function tryHandleScoutEmojiBinding(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  db: Database.Database,
): Promise<boolean> {
  const binding = liveBindings.get(reaction.message.id);
  if (!binding || user.bot) return false;

  const fullUser = user.partial ? await user.fetch() : user;
  const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
  const message = fullReaction.message.partial ? await fullReaction.message.fetch() : fullReaction.message;
  if (binding.expiresAt <= Date.now()) {
    liveBindings.delete(message.id);
    await message.edit('Scout role emoji binding expired. Run `/scout config bind_emoji:true` to start again.');
    return true;
  }

  const guild = message.guild;
  if (!guild || guild.id !== binding.state.guildId) {
    liveBindings.delete(message.id);
    return true;
  }

  await guild.emojis.fetch();
  const result = advanceScoutEmojiBinding(binding.state, {
    userId: fullUser.id,
    emojiId: fullReaction.emoji.id,
    guildEmojiIds: new Set(guild.emojis.cache.keys()),
  });

  if (result.outcome === 'ignored-user') return true;

  const warningByOutcome: Partial<Record<BindingResult['outcome'], string>> = {
    'invalid-standard': 'Use a custom emoji from this server, not a standard Unicode emoji.',
    'invalid-guild': 'That custom emoji does not belong to this server.',
    duplicate: 'Each scout role needs a different emoji.',
  };
  const warning = warningByOutcome[result.outcome];
  if (warning) {
    await fullReaction.users.remove(fullUser.id).catch(() => undefined);
    await message.edit(bindingMessage(binding.state, warning));
    return true;
  }

  if (result.outcome === 'complete' && result.emojiByRole) {
    setScoutEmojiByRole(db, guild.id, result.emojiByRole);
    liveBindings.delete(message.id);
    await message.edit(`${bindingMessage(result.state)}\n✅ All five scout role emoji are saved.`);
    return true;
  }

  binding.state = result.state;
  await message.edit(bindingMessage(result.state));
  return true;
}
