import type Database from 'better-sqlite3';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
} from 'discord.js';
import type {
  ChatInputCommandInteraction,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from 'discord.js';
import { setScoutEmojiByRole } from '../db/index.js';
import {
  SCOUT_ROLES,
  SCOUT_SIGNUP_ROLES,
  SCOUT_SIGNUP_ROLE_LABELS,
  type ScoutRole,
} from '../domain/index.js';

const BINDING_TTL_MS = 15 * 60 * 1_000;
export const SCOUT_SKIP_FILL_CUSTOM_ID = 'scout:config:skip_fill';

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
  outcome: 'ignored-user' | 'invalid-standard' | 'invalid-guild' | 'duplicate' | 'progress' | 'awaiting-fill' | 'complete';
  state: ScoutEmojiBindingState;
  emojiByRole?: Record<ScoutRole, string> & { fill: string | null };
};

type LiveBinding = {
  state: ScoutEmojiBindingState;
  expiresAt: number;
};

const liveBindings = new Map<string, LiveBinding>();

export function createScoutEmojiBindingState(guildId: string, userId: string): ScoutEmojiBindingState {
  return { guildId, userId, emojiIds: [] };
}

function completedEmojiMap(emojiIds: readonly string[]): Record<ScoutRole, string> & { fill: string | null } {
  return {
    ...(Object.fromEntries(SCOUT_ROLES.map((role, index) => [role, emojiIds[index]])) as Record<ScoutRole, string>),
    fill: emojiIds[SCOUT_ROLES.length] ?? null,
  };
}

export function advanceScoutEmojiBinding(state: ScoutEmojiBindingState, input: BindingInput): BindingResult {
  if (state.emojiIds.length === SCOUT_SIGNUP_ROLES.length) {
    return { outcome: 'complete', state, emojiByRole: completedEmojiMap(state.emojiIds) };
  }
  if (input.userId !== state.userId) return { outcome: 'ignored-user', state };
  if (!input.emojiId) return { outcome: 'invalid-standard', state };
  if (!input.guildEmojiIds.has(input.emojiId)) return { outcome: 'invalid-guild', state };
  if (state.emojiIds.includes(input.emojiId)) return { outcome: 'duplicate', state };

  const nextState = { ...state, emojiIds: [...state.emojiIds, input.emojiId] };
  if (nextState.emojiIds.length === SCOUT_SIGNUP_ROLES.length) {
    return { outcome: 'complete', state: nextState, emojiByRole: completedEmojiMap(nextState.emojiIds) };
  }
  if (nextState.emojiIds.length === SCOUT_ROLES.length) return { outcome: 'awaiting-fill', state: nextState };
  return { outcome: 'progress', state: nextState };
}

export function skipScoutFillEmojiBinding(state: ScoutEmojiBindingState, userId: string): BindingResult {
  if (userId !== state.userId) return { outcome: 'ignored-user', state };
  if (state.emojiIds.length !== SCOUT_ROLES.length) return { outcome: 'progress', state };
  return { outcome: 'complete', state, emojiByRole: completedEmojiMap(state.emojiIds) };
}

function bindingMessage(state: ScoutEmojiBindingState, warning?: string): string {
  const assigned = state.emojiIds.map((emojiId, index) => `${SCOUT_SIGNUP_ROLE_LABELS[SCOUT_SIGNUP_ROLES[index]!]}: <:role:${emojiId}>`);
  const nextRole = SCOUT_SIGNUP_ROLES[state.emojiIds.length];
  return [
    '**Scout role emoji binding**',
    `Only <@${state.userId}> can complete this binding. It expires in 15 minutes.`,
    warning ? `⚠️ ${warning}` : undefined,
    assigned.length ? assigned.join('\n') : undefined,
    nextRole ? `React to this message with this server's custom emoji for **${SCOUT_SIGNUP_ROLE_LABELS[nextRole]}**.` : undefined,
    state.emojiIds.length === SCOUT_ROLES.length ? 'Fill is optional. Use the button below to skip it.' : undefined,
    'Order: Solo → Jungle → Mid → Support → Carry → Fill (optional).',
  ]
    .filter(Boolean)
    .join('\n');
}

function bindingComponents(state: ScoutEmojiBindingState) {
  if (state.emojiIds.length !== SCOUT_ROLES.length) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(SCOUT_SKIP_FILL_CUSTOM_ID)
        .setLabel('Skip Fill')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
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
    void message.edit({
      content: 'Scout role emoji binding expired. Run `/scout config bind_emoji:true` to start again.',
      components: [],
    }).catch(() => undefined);
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
    await message.edit({
      content: 'Scout role emoji binding expired. Run `/scout config bind_emoji:true` to start again.',
      components: [],
    });
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
    await message.edit({
      content: `${bindingMessage(result.state)}\n✅ Scout role emoji are saved.`,
      components: [],
    });
    return true;
  }

  binding.state = result.state;
  await message.edit({ content: bindingMessage(result.state), components: bindingComponents(result.state) });
  return true;
}

export async function handleScoutFillSkipButton(
  interaction: ButtonInteraction,
  db: Database.Database,
): Promise<boolean> {
  if (interaction.customId !== SCOUT_SKIP_FILL_CUSTOM_ID) return false;
  const binding = liveBindings.get(interaction.message.id);
  if (!binding || binding.expiresAt <= Date.now()) {
    liveBindings.delete(interaction.message.id);
    await interaction.update({ content: 'Scout role emoji binding expired. Run `/scout config bind_emoji:true` to start again.', components: [] });
    return true;
  }
  const result = skipScoutFillEmojiBinding(binding.state, interaction.user.id);
  if (result.outcome === 'ignored-user') {
    await interaction.reply({ content: 'Only the admin who started this binding can skip Fill.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (result.outcome !== 'complete' || !result.emojiByRole) return true;
  setScoutEmojiByRole(db, binding.state.guildId, result.emojiByRole);
  liveBindings.delete(interaction.message.id);
  await interaction.update({ content: `${bindingMessage(result.state)}\n✅ Five scout role emoji are saved; Fill was skipped.`, components: [] });
  return true;
}
