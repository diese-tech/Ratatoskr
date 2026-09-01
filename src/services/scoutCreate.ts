import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
} from 'discord.js';
import type Database from 'better-sqlite3';
import type { DivisionKey } from '../config/guild-structure.js';
import {
  createScoutSetup,
  ensureScoutConfig,
  getScoutConfig,
  getScoutSetupById,
  listDivisions,
  listManagedResourcesByDomain,
  listOverlappingScoutSetups,
  listPostingScoutSetups,
  markScoutSetupPostingFailed,
  missingScoutConfigFields,
  activatePostedScoutSetup,
  replaceScoutPostingMessage,
  setScoutPostingMessage,
  type DivisionRecord,
  type ScoutSetup,
} from '../db/index.js';
import { parseScoutStartTime } from '../domain/scoutTime.js';
import { SCOUT_ROLES, SCOUT_SIGNUP_ROLES, type ScoutRole } from '../domain/index.js';
import { hasScoutDivisionManagementAccess } from './scoutAuthorization.js';
import { resolveScoutChannelGroupForDivision, type ScoutChannelGroup } from './scoutChannels.js';
import { renderScoutSignupPost } from './scoutSignupPost.js';

const DRAFT_TTL_MS = 15 * 60 * 1_000;
const CUSTOM_ID_PREFIX = 'scout:create:';

export function scoutSignupMarker(setupId: number): string {
  return `SCOUT-SIGNUP-${setupId}`;
}

export function renderPersistedScoutSignupPost(setup: ScoutSetup): string {
  return `${renderScoutSignupPost(setup)}\n\n\`${scoutSignupMarker(setup.id)}\``;
}

async function findRecoverableSignupMessage(
  channel: { messages: { fetch(options: { limit: number; before?: string }): Promise<{
    size: number;
    find(predicate: (message: Message) => boolean): Message | undefined;
    last(): Message | undefined;
  }> } },
  botUserId: string | undefined,
  setupId: number,
): Promise<Message | undefined> {
  if (!botUserId) return undefined;
  const marker = scoutSignupMarker(setupId);
  let before: string | undefined;
  while (true) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const found = page.find((message) => message.author.id === botUserId && message.content.includes(marker));
    if (found || page.size < 100) return found;
    before = page.last()?.id;
    if (!before) return undefined;
  }
}

export async function ensurePostedScoutSetup(
  client: Client,
  db: Database.Database,
  setup: ScoutSetup,
): Promise<Message> {
  if (setup.status !== 'posting') throw new Error(`Scout setup #${setup.id} is not awaiting posting.`);
  const channel = await client.channels.fetch(setup.signupChannelId);
  if (!channel?.isSendable()) throw new Error('Signup channel is not sendable.');

  let message = setup.signupMessageId
    ? await channel.messages.fetch(setup.signupMessageId).catch(() => undefined)
    : undefined;
  if (!message) message = await findRecoverableSignupMessage(channel, client.user?.id, setup.id);
  if (!message) {
    message = await channel.send({
      content: renderPersistedScoutSignupPost(setup),
      components: [],
      allowedMentions: { parse: [], roles: [setup.divisionRoleId], users: [] },
    });
  }

  if (!setup.signupMessageId) {
    if (!setScoutPostingMessage(db, setup.id, message.id)) {
      await message.delete().catch(() => undefined);
      throw new Error('Scout setup could not record its signup post.');
    }
  } else if (setup.signupMessageId !== message.id) {
    if (!replaceScoutPostingMessage(db, setup.id, setup.signupMessageId, message.id)) {
      await message.delete().catch(() => undefined);
      throw new Error('Scout setup could not replace its missing signup post.');
    }
  }

  for (const emojiId of scoutSignupEmojiIds(setup.emojiByRole)) await message.react(emojiId);
  if (!activatePostedScoutSetup(db, setup.id)) throw new Error('Scout setup could not be activated after posting.');
  return message;
}

export async function reconcilePostingScoutSetups(client: Client, db: Database.Database): Promise<void> {
  for (const setup of listPostingScoutSetups(db)) {
    try {
      await ensurePostedScoutSetup(client, db, setup);
    } catch (error) {
      console.error(`Scout signup post reconciliation failed for setup #${setup.id}`, error);
    }
  }
}

type ScoutCreateDraft = {
  id: string;
  guildId: string;
  userId: string;
  divisionId: number;
  divisionKey: string;
  divisionDisplayName: string;
  operationsChannelId: string;
  signupChannelId: string;
  resultsChannelId: string;
  divisionRoleId: string;
  eligibilityRoleId: string | null;
  emojiByRole: Record<ScoutRole, string> & { fill: string | null };
  timezone: string;
  startInput: string;
  startAt: number | null;
  roleLimit: number;
  note: string | null;
  expiresAt: number;
  posting: boolean;
};

type ResolvedScope = {
  group: ScoutChannelGroup;
  division: DivisionRecord;
  member: GuildMember;
};

const drafts = new Map<string, ScoutCreateDraft>();

function liveChannelMap(guild: Guild) {
  return new Map(
    guild.channels.cache
      .filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice)
      .map((channel) => [
        channel.id,
        {
          resourceType: channel.type === ChannelType.GuildText ? ('text_channel' as const) : ('voice_channel' as const),
          parentId: channel.parentId,
        },
      ]),
  );
}

async function resolveScope(
  guild: Guild,
  userId: string,
  sourceChannelId: string,
  divisionKey: string,
  db: Database.Database,
): Promise<ResolvedScope | undefined> {
  const config = getScoutConfig(db, guild.id);
  if (
    !config?.operationsCategoryId ||
    !config.operationsChannelId ||
    sourceChannelId !== config.operationsChannelId
  ) return undefined;
  const divisions = listDivisions(db, guild.id);
  const managedResources = listManagedResourcesByDomain(db, guild.id, 'division');
  const group = resolveScoutChannelGroupForDivision({
    guildId: guild.id,
    divisionKey,
    operationsCategoryId: config.operationsCategoryId,
    divisions,
    managedResources,
    liveChannels: liveChannelMap(guild),
  });
  if (!group) return undefined;

  const division = divisions.find((candidate) => candidate.id === group.divisionId && candidate.status === 'active');
  if (!division) return undefined;
  const member = await guild.members.fetch(userId);
  return { group, division, member };
}

async function canManageScope(scope: ResolvedScope, guildId: string, db: Database.Database): Promise<boolean> {
  const config = getScoutConfig(db, guildId);
  const { hasAccess } = await import('./authorization.js');
  return hasScoutDivisionManagementAccess(scope.member, config, scope.division, hasAccess(scope.member, 'ADMIN'));
}

function completeEmojiMap(
  config: NonNullable<ReturnType<typeof getScoutConfig>>,
): (Record<ScoutRole, string> & { fill: string | null }) | undefined {
  if (SCOUT_ROLES.some((role) => !config.emojiByRole[role])) return undefined;
  return {
    ...(Object.fromEntries(SCOUT_ROLES.map((role) => [role, config.emojiByRole[role]!])) as Record<ScoutRole, string>),
    fill: config.emojiByRole.fill,
  };
}

export function scoutSignupEmojiIds(
  emojiByRole: Readonly<Record<ScoutRole, string> & { fill: string | null }>,
): string[] {
  return SCOUT_SIGNUP_ROLES.flatMap((role) => {
    const emojiId = emojiByRole[role];
    return emojiId ? [emojiId] : [];
  });
}

function detailsModal(draft: ScoutCreateDraft): ModalBuilder {
  const start = new TextInputBuilder()
    .setCustomId('start_time')
    .setLabel(`Start time (${draft.timezone})`)
    .setPlaceholder('Tonight at 8, tomorrow 7pm, or 9/5 at 6pm')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  if (draft.startInput) start.setValue(draft.startInput);

  const roleLimit = new TextInputBuilder()
    .setCustomId('role_limit')
    .setLabel('Roles each player may select (1-5)')
    .setStyle(TextInputStyle.Short)
    .setValue(String(draft.roleLimit))
    .setRequired(true);

  const note = new TextInputBuilder()
    .setCustomId('note')
    .setLabel('Optional note')
    .setPlaceholder('Anything players should know')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(false);
  if (draft.note) note.setValue(draft.note);

  return new ModalBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}details:${draft.id}`)
    .setTitle(`${draft.divisionDisplayName} scout setup`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(start),
      new ActionRowBuilder<TextInputBuilder>().addComponents(roleLimit),
      new ActionRowBuilder<TextInputBuilder>().addComponents(note),
    );
}

function previewView(draft: ScoutCreateDraft, error?: string) {
  const hasDetails = draft.startAt !== null;
  const content = [
    error ? `⚠️ ${error}` : undefined,
    '**Private preview — no one has been pinged.**',
    hasDetails
      ? renderScoutSignupPost({
          divisionDisplayName: draft.divisionDisplayName,
          startAt: draft.startAt!,
          roleLimit: draft.roleLimit,
          note: draft.note,
          eligibilityRoleId: draft.eligibilityRoleId,
        })
      : 'Fix the setup details before posting.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const roleMenu = new RoleSelectMenuBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}eligibility:${draft.id}`)
    .setPlaceholder('Eligible role (optional)')
    .setMinValues(0)
    .setMaxValues(1);
  if (draft.eligibilityRoleId) roleMenu.setDefaultRoles(draft.eligibilityRoleId);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}post:${draft.id}`)
      .setLabel('Post scout signups')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!hasDetails),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}edit:${draft.id}`)
      .setLabel('Edit details')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}cancel:${draft.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );
  return {
    content,
    components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleMenu), row],
  };
}

function getLiveDraft(draftId: string): ScoutCreateDraft | undefined {
  const draft = drafts.get(draftId);
  if (!draft) return undefined;
  if (draft.expiresAt <= Date.now()) {
    drafts.delete(draftId);
    return undefined;
  }
  return draft;
}

export async function handleScoutCreateCommand(
  interaction: ChatInputCommandInteraction,
  db: Database.Database,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in the YSL server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const divisionKey = interaction.options.getString('division', true) as DivisionKey;
  const scope = await resolveScope(interaction.guild, interaction.user.id, interaction.channelId, divisionKey, db);
  if (!scope) {
    await interaction.reply({
      content: 'Run `/scout create` from the configured `scout-ops` channel after an admin binds it and repairs this division with `/division add`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!(await canManageScope(scope, interaction.guild.id, db))) {
    await interaction.reply({ content: 'You do not have permission to manage scouts for this division.', flags: MessageFlags.Ephemeral });
    return;
  }

  const config = ensureScoutConfig(db, interaction.guild.id);
  const missing = missingScoutConfigFields(config);
  const emojiByRole = completeEmojiMap(config);
  if (missing.length || !emojiByRole) {
    await interaction.reply({
      content: `Scout creation is not configured yet. Missing: ${missing.join(', ')}. An admin can fix this with \`/scout config\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!scope.division.roleId) {
    await interaction.reply({
      content: 'This division has no managed ping role. An admin should run `/division add` to repair it.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const draft: ScoutCreateDraft = {
    id: randomUUID(),
    guildId: interaction.guild.id,
    userId: interaction.user.id,
    divisionId: scope.division.id,
    divisionKey: scope.division.divisionKey,
    divisionDisplayName: scope.division.displayName,
    operationsChannelId: interaction.channelId,
    signupChannelId: scope.group.signupChannelId,
    resultsChannelId: scope.group.resultsChannelId,
    divisionRoleId: scope.division.roleId,
    eligibilityRoleId: null,
    emojiByRole,
    timezone: config.timezone,
    startInput: '',
    startAt: null,
    roleLimit: 2,
    note: null,
    expiresAt: Date.now() + DRAFT_TTL_MS,
    posting: false,
  };
  drafts.set(draft.id, draft);
  setTimeout(() => {
    const current = drafts.get(draft.id);
    if (current?.expiresAt === draft.expiresAt) drafts.delete(draft.id);
  }, DRAFT_TTL_MS).unref();
  await interaction.showModal(detailsModal(draft));
}

function overlapConfirmationView(draft: ScoutCreateDraft, overlaps: ReturnType<typeof listOverlappingScoutSetups>) {
  const existing = overlaps.map((setup) => {
    const link = setup.signupMessageId
      ? `https://discord.com/channels/${setup.guildId}/${setup.signupChannelId}/${setup.signupMessageId}`
      : '_signup post is still being created_';
    return `- ${setup.divisionDisplayName} — ${setup.status} — ${link}`;
  });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}postanyway:${draft.id}`)
      .setLabel('Create another setup')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}edit:${draft.id}`)
      .setLabel('Go back')
      .setStyle(ButtonStyle.Secondary),
  );
  return {
    content: [
      '**Another setup from you is scheduled for this same time.**',
      ...existing,
      '',
      'This creates a separate signup pool. It is not the two-game shared-roster option.',
    ].join('\n'),
    components: [row],
  };
}

export async function handleScoutCreateRoleSelect(
  interaction: RoleSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  if (!interaction.customId.startsWith(`${CUSTOM_ID_PREFIX}eligibility:`)) return false;
  const draft = getLiveDraft(interaction.customId.slice(`${CUSTOM_ID_PREFIX}eligibility:`.length));
  if (!draft || !(await recheckDraftAccess(interaction, draft, db))) {
    await interaction.reply({
      content: 'This private scout setup expired, restarted, or you no longer have access. Run `/scout create` again.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  draft.eligibilityRoleId = interaction.values[0] ?? null;
  await interaction.update(previewView(draft));
  return true;
}

async function recheckDraftAccess(
  interaction: ButtonInteraction | ModalSubmitInteraction | RoleSelectMenuInteraction,
  draft: ScoutCreateDraft,
  db: Database.Database,
): Promise<boolean> {
  if (
    !interaction.guild ||
    interaction.guild.id !== draft.guildId ||
    interaction.user.id !== draft.userId ||
    interaction.channelId !== draft.operationsChannelId
  ) return false;
  const scope = await resolveScope(
    interaction.guild,
    interaction.user.id,
    draft.operationsChannelId,
    draft.divisionKey,
    db,
  );
  if (!scope) return false;
  if (
    scope.division.id !== draft.divisionId ||
    scope.group.signupChannelId !== draft.signupChannelId ||
    scope.group.resultsChannelId !== draft.resultsChannelId
  ) return false;
  return canManageScope(scope, draft.guildId, db);
}

export async function handleScoutCreateModal(
  interaction: ModalSubmitInteraction,
  db: Database.Database,
): Promise<boolean> {
  if (!interaction.customId.startsWith(`${CUSTOM_ID_PREFIX}details:`)) return false;
  const draft = getLiveDraft(interaction.customId.slice(`${CUSTOM_ID_PREFIX}details:`.length));
  if (!draft || !(await recheckDraftAccess(interaction, draft, db))) {
    await interaction.reply({
      content: 'This private scout setup expired, restarted, or you no longer have access. Run `/scout create` again.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  draft.startInput = interaction.fields.getTextInputValue('start_time').trim();
  const parsed = parseScoutStartTime(draft.startInput, draft.timezone);
  const rawRoleLimit = interaction.fields.getTextInputValue('role_limit').trim();
  const roleLimit = Number(rawRoleLimit);
  const note = interaction.fields.getTextInputValue('note').trim();

  let error: string | undefined;
  if (!parsed.ok) error = parsed.message;
  else if (!Number.isInteger(roleLimit) || roleLimit < 1 || roleLimit > 5) {
    error = 'The per-player role limit must be a whole number from 1 through 5.';
  }

  if (error) draft.startAt = null;
  else {
    draft.startAt = parsed.ok ? parsed.startAt : null;
    draft.roleLimit = roleLimit;
    draft.note = note || null;
  }

  const view = previewView(draft, error);
  if (interaction.isFromMessage()) await interaction.update(view);
  else await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
  return true;
}

export async function handleScoutCreateButton(
  interaction: ButtonInteraction,
  db: Database.Database,
): Promise<boolean> {
  if (!interaction.customId.startsWith(CUSTOM_ID_PREFIX)) return false;
  const [, , action, draftId] = interaction.customId.split(':');
  if (!draftId || !['post', 'postanyway', 'edit', 'cancel'].includes(action ?? '')) return false;

  const draft = getLiveDraft(draftId);
  if (!draft || !(await recheckDraftAccess(interaction, draft, db))) {
    await interaction.reply({
      content: 'This private scout setup expired, restarted, or you no longer have access. Run `/scout create` again.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (action === 'edit') {
    await interaction.showModal(detailsModal(draft));
    return true;
  }
  if (action === 'cancel') {
    drafts.delete(draft.id);
    await interaction.update({ content: 'Scout setup cancelled. Nothing was posted.', components: [] });
    return true;
  }
  if (draft.posting) {
    await interaction.reply({ content: 'This scout setup is already being posted.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (draft.startAt === null) {
    await interaction.reply({ content: 'Enter valid setup details before posting.', flags: MessageFlags.Ephemeral });
    return true;
  }

  if (action === 'post') {
    const overlaps = listOverlappingScoutSetups(db, draft.guildId, draft.userId, draft.startAt);
    if (overlaps.length) {
      await interaction.update(overlapConfirmationView(draft, overlaps));
      return true;
    }
  }

  draft.posting = true;
  await interaction.deferUpdate();
  let setup;
  try {
    setup = createScoutSetup(db, {
      guildId: draft.guildId,
      divisionId: draft.divisionId,
      divisionKey: draft.divisionKey,
      divisionDisplayName: draft.divisionDisplayName,
      createdBy: draft.userId,
      signupChannelId: draft.signupChannelId,
      resultsChannelId: draft.resultsChannelId,
      operationsChannelId: draft.operationsChannelId,
      divisionRoleId: draft.divisionRoleId,
      eligibilityRoleId: draft.eligibilityRoleId,
      emojiByRole: draft.emojiByRole,
      startAt: draft.startAt,
      roleLimit: draft.roleLimit,
      note: draft.note,
    });
  } catch (error) {
    draft.posting = false;
    await interaction.editReply({
      content: `Ratatoskr could not save this scout setup: ${(error as Error).message}`,
      components: [],
    });
    return true;
  }

  let signupMessage;
  try {
    signupMessage = await ensurePostedScoutSetup(interaction.client, db, setup);
  } catch (error) {
    const persisted = getScoutSetupById(db, setup.id);
    let postDeletionConfirmed = false;
    if (persisted?.signupMessageId) {
      const channel = await interaction.client.channels.fetch(persisted.signupChannelId).catch(() => undefined);
      if (channel?.isTextBased()) {
        const message = await channel.messages.fetch(persisted.signupMessageId).catch(() => undefined);
        if (message) postDeletionConfirmed = await message.delete().then(() => true, () => false);
      }
    }
    if (postDeletionConfirmed) markScoutSetupPostingFailed(db, setup.id);
    draft.posting = false;
    await interaction.editReply({
      content: postDeletionConfirmed
        ? `Ratatoskr could not post and seed the scout signup reactions: ${(error as Error).message}`
        : `Ratatoskr could not finish seeding the scout signup reactions and could not confirm cleanup of the post. The setup remains pending so startup recovery can finish it safely: ${(error as Error).message}`,
      components: [],
    });
    return true;
  }

  drafts.delete(draft.id);
  await interaction.editReply({ content: `Scout signups posted: ${signupMessage.url}`, components: [] });
  return true;
}
