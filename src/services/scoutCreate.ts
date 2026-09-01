import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
} from 'discord.js';
import type Database from 'better-sqlite3';
import {
  createScoutSetup,
  ensureScoutConfig,
  getScoutConfig,
  listDivisions,
  listManagedResourcesByDomain,
  markScoutSetupPostingFailed,
  missingScoutConfigFields,
  setScoutSetupSignupMessage,
  type DivisionRecord,
} from '../db/index.js';
import { parseScoutStartTime } from '../domain/scoutTime.js';
import { SCOUT_ROLES, SCOUT_SIGNUP_ROLES, type ScoutRole } from '../domain/index.js';
import { hasScoutManagementAccess } from './scoutAuthorization.js';
import { resolveScoutChannelGroup, type ScoutChannelGroup } from './scoutChannels.js';
import { renderScoutSignupPost } from './scoutSignupPost.js';
import { scoutCancelButtonRow } from './scoutCancel.js';

const DRAFT_TTL_MS = 15 * 60 * 1_000;
const CUSTOM_ID_PREFIX = 'scout:create:';

type ScoutCreateDraft = {
  id: string;
  guildId: string;
  userId: string;
  divisionId: number;
  divisionKey: string;
  divisionDisplayName: string;
  signupChannelId: string;
  resultsChannelId: string;
  divisionRoleId: string;
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
  db: Database.Database,
): Promise<ResolvedScope | undefined> {
  const divisions = listDivisions(db, guild.id);
  const managedResources = listManagedResourcesByDomain(db, guild.id, 'division');
  const group = resolveScoutChannelGroup({
    guildId: guild.id,
    sourceChannelId,
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
  return hasScoutManagementAccess({
    isAdmin: hasAccess(scope.member, 'ADMIN'),
    memberRoleIds: new Set(scope.member.roles.cache.keys()),
    additionalAuthorizedRoleIds: config?.authorizedRoleIds ?? [],
    divisionCaptainAccessRoleId: scope.division.captainAccessRoleId,
  });
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
        })
      : 'Fix the setup details before posting.',
  ]
    .filter(Boolean)
    .join('\n\n');

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
  return { content, components: [row] };
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

  const scope = await resolveScope(interaction.guild, interaction.user.id, interaction.channelId, db);
  if (!scope) {
    await interaction.reply({
      content: 'Run `/scout create` from a live managed division `scout-signups` channel.',
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
    signupChannelId: scope.group.signupChannelId,
    resultsChannelId: scope.group.resultsChannelId,
    divisionRoleId: scope.division.roleId,
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

async function recheckDraftAccess(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  draft: ScoutCreateDraft,
  db: Database.Database,
): Promise<boolean> {
  if (!interaction.guild || interaction.guild.id !== draft.guildId || interaction.user.id !== draft.userId) return false;
  const scope = await resolveScope(interaction.guild, interaction.user.id, draft.signupChannelId, db);
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
  if (!draftId || !['post', 'edit', 'cancel'].includes(action ?? '')) return false;

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
      divisionRoleId: draft.divisionRoleId,
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
    const channel = await interaction.client.channels.fetch(draft.signupChannelId);
    if (!channel?.isSendable()) throw new Error('Signup channel is not sendable.');
    signupMessage = await channel.send({
      content: renderScoutSignupPost({
        divisionDisplayName: draft.divisionDisplayName,
        divisionRoleId: draft.divisionRoleId,
        startAt: draft.startAt,
        roleLimit: draft.roleLimit,
        note: draft.note,
      }),
      components: [scoutCancelButtonRow(setup.id, setup.version)],
      allowedMentions: { parse: [], roles: [draft.divisionRoleId], users: [] },
    });
    if (!setScoutSetupSignupMessage(db, setup.id, signupMessage.id)) {
      throw new Error('Scout setup could not be activated after posting.');
    }
    for (const emojiId of scoutSignupEmojiIds(draft.emojiByRole)) await signupMessage.react(emojiId);
  } catch (error) {
    if (signupMessage) await signupMessage.delete().catch(() => undefined);
    markScoutSetupPostingFailed(db, setup.id);
    draft.posting = false;
    await interaction.editReply({
      content: `Ratatoskr could not post and seed the scout signup reactions: ${(error as Error).message}`,
      components: [],
    });
    return true;
  }

  drafts.delete(draft.id);
  await interaction.editReply({ content: `Scout signups posted: ${signupMessage.url}`, components: [] });
  return true;
}
