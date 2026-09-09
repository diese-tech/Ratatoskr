import { refreshScoutStatusCardSafely } from './scoutCardLifecycle.js';
import { formatScoutSlotLabel, resolveScoutPlayerNames } from './scoutPlayerNames.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import type Database from 'better-sqlite3';
import {
  getDivisionByKey,
  getScoutConfig,
  getScoutSetupById,
  expandScoutRosterToTwoGamesIfVersion,
  listScoutRosterSlots,
  listScoutSignups,
  replaceScoutRosterSlotIfVersion,
  replaceScoutRosterIfVersion,
  seatScoutRosterSlotIfVersion,
  swapScoutRosterSlotsIfVersion,
  withdrawnScoutRosterUserIds,
  type ScoutRosterSlotRecord,
  type ScoutSetup,
  type ScoutSignup,
} from '../db/index.js';
import {
  generateDifferentScoutRoster,
  generateScoutRoster,
  scoutRosterFingerprint,
  SCOUT_ROLES,
  SCOUT_ROLE_LABELS,
  SCOUT_TEAMS,
} from '../domain/index.js';
import { hasScoutDivisionManagementAccess, isScoutOperationsChannel } from './scoutAuthorization.js';
import {
  classifyScoutSignups,
  eligibleScoutSignups,
  isScoutUserEligible,
  type ScoutIneligibilityReason,
} from './scoutEligibility.js';
import { scoutCancelButton } from './scoutCancel.js';
import { reconcileWorkingScoutRoster } from './scoutSignups.js';

const TEAM_LABELS = { team_one: 'Order', team_two: 'Chaos' } as const;

function ineligibleSignupLines(
  ineligibleSignups: ReadonlyArray<{ signup: ScoutSignup; reason: ScoutIneligibilityReason }>,
  seated: ReadonlySet<string>,
): string[] {
  const byUser = new Map<string, { roles: ScoutSignup['role'][]; reason: ScoutIneligibilityReason }>();
  for (const { signup, reason } of ineligibleSignups) {
    if (seated.has(signup.userId)) continue;
    const current = byUser.get(signup.userId) ?? { roles: [], reason };
    if (!current.roles.includes(signup.role)) current.roles.push(signup.role);
    byUser.set(signup.userId, current);
  }
  return [...byUser].map(([userId, entry]) => {
    const roles = entry.roles.map((role) => role === 'fill' ? 'Fill' : SCOUT_ROLE_LABELS[role]).join(', ');
    const reason = entry.reason.kind === 'missing_role' ? `missing <@&${entry.reason.roleId}>`
      : entry.reason.kind === 'not_in_server' ? 'not currently in this server' : 'bot accounts cannot be seated';
    return `<@${userId}> · ${roles} — ${reason}`;
  });
}

function replyWithIneligibleSummary(base: string, heading: string, lines: readonly string[]): string {
  if (lines.length === 0) return base;
  const render = (shown: readonly string[], hidden: number) => `${base}\n\n${[
    `**${heading} (${lines.length})**`,
    ...shown,
    hidden ? `_${hidden} additional ineligible signup(s) omitted; see the working roster card._` : '',
  ].filter(Boolean).join('\n')}`;
  const shown: string[] = [];
  for (const line of lines) {
    const candidate = [...shown, line];
    if (render(candidate, lines.length - candidate.length).length > 2_000) break;
    shown.push(line);
  }
  return render(shown, lines.length - shown.length);
}

export function buildScoutWorkingRosterView(
  setup: ScoutSetup,
  slots: readonly ScoutRosterSlotRecord[],
  eligibleSignups: readonly ScoutSignup[],
  unavailableUserIds: ReadonlySet<string> = new Set(),
  ineligibleSignups: ReadonlyArray<{ signup: ScoutSignup; reason: ScoutIneligibilityReason }> = [],
) {
  const lines = [
    `**${setup.divisionDisplayName} Scout · <t:${setup.startAt}:t>**`,
    `Start: <t:${setup.startAt}:F> · <t:${setup.startAt}:R>`,
  ];
  for (let gameNumber = 1; gameNumber <= setup.gameCount; gameNumber++) {
    const gameSlots = slots.filter((slot) => slot.gameNumber === gameNumber);
    const missingRoles = SCOUT_ROLES.filter((role) =>
      SCOUT_TEAMS.some((team) => !gameSlots.some((slot) => slot.team === team && slot.role === role)));
    lines.push(
      '',
      ...(setup.gameCount === 2 ? [`__**Game ${gameNumber}**__`] : []),
      `**${gameSlots.length}/10 seated · ${gameSlots.length === 10 ? 'ready to publish' : `needs ${missingRoles.map((role) => SCOUT_ROLE_LABELS[role]).join(', ')}`}**`,
    );
    for (const team of SCOUT_TEAMS) {
      lines.push('', `**${TEAM_LABELS[team]}**`);
      for (const role of SCOUT_ROLES) {
        const slot = gameSlots.find((candidate) => candidate.team === team && candidate.role === role);
        const flags = slot ? [
          slot.staffAssigned ? 'manual' : '',
          slot.offRole ? 'off-role' : '',
          slot.replacementNeeded ? 'replacement needed' : '',
        ].filter(Boolean) : [];
        lines.push(`${SCOUT_ROLE_LABELS[role]}: ${slot ? `<@${slot.userId}>${flags.length ? ` *(${flags.join(', ')})*` : ''}` : '**OPEN**'}`);
      }
    }
  }

  const seated = new Set(slots.map((slot) => slot.userId));
  const rolesByUser = new Map<string, ScoutSignup['role'][]>();
  for (const signup of eligibleSignups) {
    if (seated.has(signup.userId)) continue;
    const roles = rolesByUser.get(signup.userId) ?? [];
    if (!roles.includes(signup.role)) roles.push(signup.role);
    rolesByUser.set(signup.userId, roles);
  }
  lines.push('', `**Unseated signups (${rolesByUser.size})**`);
  if (rolesByUser.size === 0) lines.push('_None_');
  else {
    let hidden = 0;
    for (const [userId, roles] of rolesByUser) {
      const line = `<@${userId}> · ${roles.map((role) => role === 'fill' ? 'Fill' : SCOUT_ROLE_LABELS[role]).join(', ')}`;
      if ([...lines, line].join('\n').length <= 1_850) lines.push(line);
      else hidden += 1;
    }
    if (hidden) lines.push(`_${hidden} additional signup(s) are available through Seat player._`);
  }
  const ineligibleLines = ineligibleSignupLines(ineligibleSignups, seated);
  if (ineligibleLines.length) {
    lines.push('', `**Ineligible signups (${ineligibleLines.length})**`);
    let hidden = 0;
    for (const line of ineligibleLines) {
      if ([...lines, line].join('\n').length <= 1_850) lines.push(line);
      else hidden += 1;
    }
    if (hidden) lines.push(`_${hidden} additional ineligible signup(s) omitted._`);
  }
  if (unavailableUserIds.size) {
    lines.push('', `⚠️ ${unavailableUserIds.size} current assignment(s) need staff attention before publication.`);
  }

  const complete = slots.length === setup.gameCount * 10 && unavailableUserIds.size === 0;
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`scout:seat:${setup.id}:${setup.version}:0`).setLabel('Seat player').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`scout:edit:role:${setup.id}:${setup.version}`).setLabel('Swap players').setStyle(ButtonStyle.Secondary)
      .setDisabled(slots.length < 2),
    new ButtonBuilder().setCustomId(`scout:refresh:${setup.id}:${setup.version}`).setLabel('Refresh draft').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`scout:publish:${setup.id}:${setup.version}`).setLabel('Publish roster').setStyle(ButtonStyle.Success)
      .setDisabled(!complete),
    scoutCancelButton(setup.id, setup.version),
  );
  return {
    content: lines.join('\n'),
    components: [controls],
    allowedMentions: { parse: [] as never[] },
  };
}

export function scoutReviewButtonRow(setupId: number, version = 0) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`scout:review:${setupId}`)
      .setLabel('Review roster')
      .setStyle(ButtonStyle.Primary),
    scoutCancelButton(setupId, version),
  );
}

export function buildScoutRosterReviewView(
  db: Database.Database,
  setupId: number,
  version: number,
  slots: ReturnType<typeof listScoutRosterSlots>,
  notice?: string,
  canBuildTwoGames = false,
) {
  const setup = getScoutSetupById(db, setupId);
  const gameCount = setup?.gameCount ?? 1;
  const withdrawn = new Set(withdrawnScoutRosterUserIds(db, setupId));
  const lines = [notice, '**Private scout roster review**'];
  for (let gameNumber = 1; gameNumber <= gameCount; gameNumber++) {
    if (gameCount === 2) lines.push('', `__**Game ${gameNumber}**__`);
    for (const [index, team] of SCOUT_TEAMS.entries()) {
      lines.push('', `**Team ${index + 1}**`);
      for (const role of SCOUT_ROLES) {
        const slot = slots.find((candidate) =>
          candidate.gameNumber === gameNumber && candidate.team === team && candidate.role === role,
        );
        const flags = slot ? `${slot.staffAssigned ? ' 🛠️' : ''}${withdrawn.has(slot.userId) ? ' ⚠️ signup withdrawn' : ''}` : '';
        lines.push(`${SCOUT_ROLE_LABELS[role]}: ${slot ? `<@${slot.userId}>${flags}` : '_empty_'}`);
      }
    }
  }
  if (withdrawn.size) lines.push('', '⚠️ Publishing is blocked until every withdrawn signup is resolved.');
  const managementButtons = [
    new ButtonBuilder()
      .setCustomId(`scout:shuffle:${setupId}:${version}`)
      .setLabel('Shuffle')
      .setStyle(ButtonStyle.Secondary),
    ...(gameCount === 1 ? [new ButtonBuilder()
      .setCustomId(`scout:edit:swap:${setupId}:${version}`)
      .setLabel('Swap teams')
      .setStyle(ButtonStyle.Secondary)] : []),
    new ButtonBuilder().setCustomId(`scout:edit:role:${setupId}:${version}`).setLabel('Swap any two players').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`scout:edit:replace:${setupId}:${version}`).setLabel('Replace slot').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`scout:publish:${setupId}:${version}`)
      .setLabel('Publish')
      .setStyle(ButtonStyle.Success)
      .setDisabled(withdrawn.size > 0 || slots.length !== gameCount * 10),
  ];
  const components: ActionRowBuilder<ButtonBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(managementButtons),
  ];
  if (gameCount === 1 && canBuildTwoGames) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`scout:buildtwo:${setupId}:${version}`)
        .setLabel('Build 2 games')
        .setStyle(ButtonStyle.Primary),
    ));
  }
  return {
    content: lines.filter((line): line is string => Boolean(line)).join('\n'),
    allowedMentions: { parse: [] as never[] },
    components,
  };
}

async function reviewViewWithExpansion(
  interaction: MessageComponentInteraction,
  db: Database.Database,
  setupId: number,
  notice?: string,
) {
  const setup = getScoutSetupById(db, setupId)!;
  let canBuildTwoGames = false;
  if (setup.gameCount === 1 && interaction.guild) {
    const signups = await eligibleScoutSignups(interaction.guild, listScoutSignups(db, setupId), setup.eligibilityRoleId);
    canBuildTwoGames = generateScoutRoster(signups, { gameCount: 2 }).feasible;
  }
  return buildScoutRosterReviewView(
    db, setupId, setup.version, listScoutRosterSlots(db, setupId), notice, canBuildTwoGames,
  );
}

async function authorized(interaction: MessageComponentInteraction, db: Database.Database, setupId: number) {
  const setup = getScoutSetupById(db, setupId);
  if (!setup || setup.guildId !== interaction.guildId || !['open', 'roster_ready'].includes(setup.status) || !interaction.guild) return undefined;
  if (!isScoutOperationsChannel(setup, interaction.channelId)) return undefined;
  const division = getDivisionByKey(db, setup.guildId, setup.divisionKey);
  if (!division || division.id !== setup.divisionId || division.status !== 'active') return undefined;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const config = getScoutConfig(db, setup.guildId);
  const { hasAccess } = await import('./authorization.js');
  const allowed = hasScoutDivisionManagementAccess(db, member, config, division, hasAccess(member, 'ADMIN'));
  return allowed ? setup : undefined;
}

async function showSeatPlayerPicker(
  interaction: ButtonInteraction,
  db: Database.Database,
  setupId: number,
  version: number,
  page: number,
) {
  const setup = getScoutSetupById(db, setupId)!;
  if (setup.version !== version) {
    await interaction.editReply({ content: 'That working roster changed. Use the current Scout Ops controls.' });
    return;
  }
  const eligibility = await classifyScoutSignups(
    interaction.guild!, listScoutSignups(db, setupId), setup.eligibilityRoleId,
  );
  const eligible = eligibility.eligibleSignups;
  const rostered = new Set(listScoutRosterSlots(db, setupId).map((slot) => slot.userId));
  const userIds = [...new Set(eligible.map((signup) => signup.userId))].filter((userId) => !rostered.has(userId));
  const start = Math.max(0, page) * 25;
  const shown = userIds.slice(start, start + 25);
  if (shown.length === 0) {
    const excluded = userIds.length === 0 ? ineligibleSignupLines(eligibility.ineligibleSignups, rostered) : [];
    await interaction.editReply({
      content: replyWithIneligibleSummary(
        'There are no eligible unseated signups on that page.', 'Ineligible signups', excluded,
      ),
      components: [],
      allowedMentions: { parse: [] },
    });
    return;
  }
  const names = await resolveScoutPlayerNames(interaction.guild!, shown);
  const rolesByUser = new Map(shown.map((userId) => [userId, eligible
    .filter((signup) => signup.userId === userId)
    .map((signup) => signup.role === 'fill' ? 'Fill' : SCOUT_ROLE_LABELS[signup.role])
    .join(', ')]));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`scout:seatplayer:${setupId}:${version}:${page}`)
    .setPlaceholder('Player to seat')
    .addOptions(shown.map((userId) => new StringSelectMenuOptionBuilder()
      .setLabel(names.get(userId) ?? userId)
      .setDescription(rolesByUser.get(userId)!.slice(0, 100))
      .setValue(userId)));
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [selectRow(menu)];
  if (userIds.length > 25) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`scout:seat:${setupId}:${version}:${Math.max(0, page - 1)}`)
        .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`scout:seat:${setupId}:${version}:${page + 1}`)
        .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(start + 25 >= userIds.length),
    ));
  }
  await interaction.editReply({ content: `Choose an eligible unseated signup (page ${page + 1}).`, components: rows });
}

function selectRow(menu: StringSelectMenuBuilder | UserSelectMenuBuilder) {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu);
}

async function showEditPicker(
  interaction: ButtonInteraction,
  db: Database.Database,
  setupId: number,
  version: number,
  action: 'swap' | 'role' | 'replace',
) {
  const slots = listScoutRosterSlots(db, setupId);
  const names = await resolveScoutPlayerNames(interaction.guild!, slots.map((slot) => slot.userId));
  if (action === 'swap') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`scout:editpick:swap:${setupId}:${version}`)
      .setPlaceholder('Role to swap between teams')
      .addOptions(SCOUT_ROLES.map((role) => new StringSelectMenuOptionBuilder().setLabel(SCOUT_ROLE_LABELS[role]).setValue(role)));
    await interaction.editReply({ content: 'Choose the role whose two players should swap teams.', components: [selectRow(menu)] });
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`scout:editpick:${action}first:${setupId}:${version}`)
    .setPlaceholder(action === 'role' ? 'First player to exchange' : 'Slot to replace')
    .addOptions(slots.map((slot) => new StringSelectMenuOptionBuilder().setLabel(formatScoutSlotLabel(slot, names.get(slot.userId))).setValue(String(slot.id))));
  await interaction.editReply({
    content: action === 'role' ? 'Choose the first occupied slot in the role exchange.' : 'Choose the roster slot to replace.',
    components: [selectRow(menu)],
  });
}

async function handleScoutReviewButtonImpl(interaction: ButtonInteraction, db: Database.Database): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || ![
    'review', 'shuffle', 'edit', 'buildtwo', 'buildtwoconfirm', 'buildtwoback',
    'seat', 'seatconfirm', 'seatback', 'refresh',
  ].includes(parts[1] ?? '')) return false;
  const editing = parts[1] === 'edit';
  const setupId = Number(parts[editing ? 3 : 2]);
  if (!Number.isInteger(setupId)) return false;
  if (['review', 'edit', 'seat', 'refresh'].includes(parts[1]!)) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();
  const setup = await authorized(interaction, db, setupId);
  if (!setup) {
    await interaction.editReply({ content: 'You do not have permission to review this division roster.' });
    return true;
  }

  if (parts[1] === 'review') {
    await interaction.editReply({ ...await reviewViewWithExpansion(interaction, db, setup.id) });
    return true;
  }

  if (parts[1] === 'seatback') {
    await interaction.editReply({ content: 'Seating cancelled.', components: [] });
    return true;
  }

  if (parts[1] === 'seat') {
    const expectedVersion = Number(parts[3]);
    const page = Number(parts[4] ?? 0);
    if (!Number.isInteger(expectedVersion) || !Number.isInteger(page)) return false;
    await showSeatPlayerPicker(interaction, db, setup.id, expectedVersion, page);
    return true;
  }

  if (parts[1] === 'refresh') {
    const expectedVersion = Number(parts[3]);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== setup.version) {
      await interaction.editReply({ content: 'That working roster changed. Use the current Scout Ops controls.' });
      return true;
    }
    const eligibility = await classifyScoutSignups(
      interaction.guild!, listScoutSignups(db, setup.id), setup.eligibilityRoleId,
    );
    const outcome = reconcileWorkingScoutRoster(
      db, setup.id, eligibility.eligibleSignups, 'refresh', interaction.user.id, expectedVersion,
    );
    const rostered = new Set(listScoutRosterSlots(db, setup.id).map((slot) => slot.userId));
    const excluded = ineligibleSignupLines(eligibility.ineligibleSignups, rostered);
    const result = outcome === 'stale'
      ? 'The working roster changed during refresh. No stale update was applied.'
      : outcome === 'unchanged' ? 'The working roster is already current.' : 'Working roster refreshed.';
    await interaction.editReply({
      content: replyWithIneligibleSummary(result, 'Ineligible signups excluded', excluded),
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (parts[1] === 'seatconfirm') {
    const expectedVersion = Number(parts[3]);
    const userId = parts[4];
    const gameNumber = Number(parts[5]) as 1 | 2;
    const team = parts[6] as (typeof SCOUT_TEAMS)[number];
    const role = parts[7] as (typeof SCOUT_ROLES)[number];
    if (!userId || !Number.isInteger(expectedVersion) || ![1, 2].includes(gameNumber) ||
        !SCOUT_TEAMS.includes(team) || !SCOUT_ROLES.includes(role)) return false;
    const member = await interaction.guild!.members.fetch(userId).catch(() => undefined);
    const eligible = member && isScoutUserEligible(member.roles.cache.keys(), setup.eligibilityRoleId);
    if (!eligible) {
      await interaction.editReply({ content: 'That player is no longer eligible. No seat was changed.', components: [] });
      return true;
    }
    const outcome = seatScoutRosterSlotIfVersion(db, {
      setupId, expectedVersion, gameNumber, team, role, userId,
      actorUserId: interaction.user.id, confirmOffRole: true,
    });
    await interaction.editReply({ content: outcome === 'updated' ? 'Player seated.' : `No change was made (${outcome}).`, components: [] });
    return true;
  }

  if (parts[1] === 'buildtwoback') {
    await interaction.editReply(await reviewViewWithExpansion(interaction, db, setup.id));
    return true;
  }

  if (parts[1] === 'buildtwo') {
    const expectedVersion = Number(parts[3]);
    if (!Number.isInteger(expectedVersion)) return false;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`scout:buildtwoconfirm:${setupId}:${expectedVersion}`).setLabel('Confirm 2 games').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`scout:buildtwoback:${setupId}:${expectedVersion}`).setLabel('Back').setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({
      content: 'Build two games from all currently eligible signups? This recalculates both games and replaces any manual edits in the current one-game roster. You can then shuffle or swap players across either game before publishing.',
      components: [row],
    });
    return true;
  }

  if (parts[1] === 'buildtwoconfirm') {
    const expectedVersion = Number(parts[3]);
    if (!Number.isInteger(expectedVersion)) return false;
    const signups = await eligibleScoutSignups(interaction.guild!, listScoutSignups(db, setup.id), setup.eligibilityRoleId);
    const generated = generateScoutRoster(signups, { gameCount: 2 });
    if (!generated.feasible) {
      await interaction.editReply(await reviewViewWithExpansion(interaction, db, setup.id, 'There are no longer enough compatible eligible signups to build two games.'));
      return true;
    }
    if (!expandScoutRosterToTwoGamesIfVersion(db, setup.id, expectedVersion, generated.slots)) {
      await interaction.editReply(await reviewViewWithExpansion(interaction, db, setup.id, 'That confirmation was stale; no change was made.'));
      return true;
    }
    await interaction.editReply(await reviewViewWithExpansion(interaction, db, setup.id, 'Two-game roster built.'));
    return true;
  }

  if (editing) {
    const action = parts[2];
    const version = Number(parts[4]);
    if (!['swap', 'role', 'replace'].includes(action ?? '') || !Number.isInteger(version)) return false;
    await showEditPicker(interaction, db, setup.id, version, action as 'swap' | 'role' | 'replace');
    return true;
  }

  const expectedVersion = Number(parts[3]);
  if (!Number.isInteger(expectedVersion)) return false;
  const current = listScoutRosterSlots(db, setup.id);
  const signups = await eligibleScoutSignups(interaction.guild!, listScoutSignups(db, setup.id), setup.eligibilityRoleId);
  const generated = generateDifferentScoutRoster(signups, scoutRosterFingerprint(current), Math.random, setup.gameCount);
  if (!generated.result.feasible || !generated.isDifferent) {
    await interaction.editReply(buildScoutRosterReviewView(db, setup.id, setup.version, current, 'No different valid roster is available.'));
    return true;
  }
  if (!replaceScoutRosterIfVersion(db, setup.id, expectedVersion, generated.result.slots)) {
    const latest = getScoutSetupById(db, setup.id)!;
    await interaction.editReply(buildScoutRosterReviewView(db, setup.id, latest.version, listScoutRosterSlots(db, setup.id), 'That view was stale; showing the current roster.'));
    return true;
  }
  const updated = getScoutSetupById(db, setup.id)!;
  await interaction.editReply(buildScoutRosterReviewView(db, setup.id, updated.version, listScoutRosterSlots(db, setup.id), 'Roster shuffled.'));
  return true;
}

async function handleScoutReviewStringSelectImpl(
  interaction: StringSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] === 'scout' && ['seatplayer', 'seatlocation'].includes(parts[1] ?? '')) {
    const setupId = Number(parts[2]);
    const expectedVersion = Number(parts[3]);
    if (!Number.isInteger(setupId) || !Number.isInteger(expectedVersion)) return false;
    await interaction.deferUpdate();
    const setup = await authorized(interaction, db, setupId);
    if (!setup) {
      await interaction.editReply({ content: 'You do not have permission to edit this division roster.', components: [] });
      return true;
    }
    if (setup.version !== expectedVersion) {
      await interaction.editReply({ content: 'That working roster changed. Use the current Scout Ops controls.', components: [] });
      return true;
    }
    const userId = parts[1] === 'seatplayer' ? interaction.values[0] : parts[4];
    if (!userId) return false;
    const eligibleSignups = await eligibleScoutSignups(
      interaction.guild!, listScoutSignups(db, setupId), setup.eligibilityRoleId,
    );
    const member = await interaction.guild!.members.fetch(userId).catch(() => undefined);
    const stillEligible = member && isScoutUserEligible(member.roles.cache.keys(), setup.eligibilityRoleId) &&
      eligibleSignups.some((signup) => signup.userId === userId) &&
      !listScoutRosterSlots(db, setupId).some((slot) => slot.userId === userId);
    if (!stillEligible) {
      await interaction.editReply({ content: 'That player is no longer an eligible unseated signup.', components: [] });
      return true;
    }
    if (parts[1] === 'seatplayer') {
      const occupied = new Set(listScoutRosterSlots(db, setupId)
        .map((slot) => `${slot.gameNumber}|${slot.team}|${slot.role}`));
      const locations = Array.from({ length: setup.gameCount }, (_, index) => index + 1)
        .flatMap((gameNumber) => SCOUT_TEAMS.flatMap((team) => SCOUT_ROLES.map((role) => ({ gameNumber, team, role }))))
        .filter((location) => !occupied.has(`${location.gameNumber}|${location.team}|${location.role}`));
      if (locations.length === 0) {
        await interaction.editReply({ content: 'This working roster has no open seats.', components: [] });
        return true;
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`scout:seatlocation:${setupId}:${expectedVersion}:${userId}`)
        .setPlaceholder('Game, team, and role')
        .addOptions(locations.map((location) => new StringSelectMenuOptionBuilder()
          .setLabel(`${setup.gameCount === 2 ? `Game ${location.gameNumber} · ` : ''}${TEAM_LABELS[location.team]} · ${SCOUT_ROLE_LABELS[location.role]}`)
          .setValue(`${location.gameNumber}|${location.team}|${location.role}`)));
      await interaction.editReply({ content: `Choose an open seat for <@${userId}>.`, components: [selectRow(menu)], allowedMentions: { parse: [] } });
      return true;
    }

    const [rawGame, rawTeam, rawRole] = (interaction.values[0] ?? '').split('|');
    const gameNumber = Number(rawGame) as 1 | 2;
    const team = rawTeam as (typeof SCOUT_TEAMS)[number];
    const role = rawRole as (typeof SCOUT_ROLES)[number];
    if (![1, 2].includes(gameNumber) || !SCOUT_TEAMS.includes(team) || !SCOUT_ROLES.includes(role)) return false;
    const signedRoles = eligibleSignups.filter((signup) => signup.userId === userId).map((signup) => signup.role);
    const offRole = !signedRoles.some((signupRole) => signupRole === role || signupRole === 'fill');
    if (offRole) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`scout:seatconfirm:${setupId}:${expectedVersion}:${userId}:${gameNumber}:${team}:${role}`)
          .setLabel('Seat anyway').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`scout:seatback:${setupId}:${expectedVersion}`)
          .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({
        content: `⚠️ ${SCOUT_ROLE_LABELS[role]} was not one of <@${userId}>'s signup roles.`,
        components: [row], allowedMentions: { parse: [] },
      });
      return true;
    }
    const outcome = seatScoutRosterSlotIfVersion(db, {
      setupId, expectedVersion, gameNumber, team, role, userId,
      actorUserId: interaction.user.id, confirmOffRole: false,
    });
    await interaction.editReply({ content: outcome === 'updated' ? 'Player seated.' : `No change was made (${outcome}).`, components: [] });
    return true;
  }
  if (parts[0] !== 'scout' || parts[1] !== 'editpick') return false;
  const action = parts[2] ?? '';
  const setupId = Number(parts[3]);
  const expectedVersion = Number(parts[4]);
  if (!Number.isInteger(setupId) || !Number.isInteger(expectedVersion)) return false;
  await interaction.deferUpdate();
  const setup = await authorized(interaction, db, setupId);
  if (!setup) {
    await interaction.editReply({ content: 'You do not have permission to edit this division roster.' });
    return true;
  }
  const selected = interaction.values[0];
  const slots = listScoutRosterSlots(db, setupId);
  const names = await resolveScoutPlayerNames(interaction.guild!, slots.map((slot) => slot.userId));

  if (action === 'swap') {
    const pair = slots.filter((slot) => slot.role === selected);
    const changed = pair.length === 2 && swapScoutRosterSlotsIfVersion(
      db, setupId, expectedVersion, pair[0]!.id, pair[1]!.id, false, interaction.user.id,
    );
    const latest = getScoutSetupById(db, setupId)!;
    await interaction.editReply(buildScoutRosterReviewView(db, setupId, latest.version, listScoutRosterSlots(db, setupId), changed ? 'Players swapped between teams.' : 'That view was stale; no change was made.'));
    return true;
  }

  if (action === 'eligible') {
    const slotId = Number(parts[5]);
    const slot = slots.find((candidate) => candidate.id === slotId);
    const selectedMember = selected ? await interaction.guild?.members.fetch(selected).catch(() => undefined) : undefined;
    const stillEligible = slot && selectedMember &&
      isScoutUserEligible(selectedMember.roles.cache.keys(), setup.eligibilityRoleId) &&
      listScoutSignups(db, setupId).some(
        (signup) => signup.userId === selected && (signup.role === slot.role || signup.role === 'fill'),
      );
    if (!stillEligible) {
      await interaction.editReply(buildScoutRosterReviewView(db, setupId, setup.version, slots, 'That player is no longer an eligible signup for this slot.'));
      return true;
    }
    const outcome = replaceScoutRosterSlotIfVersion(
      db, setupId, expectedVersion, slotId, selected!, false, interaction.user.id,
    );
    const latest = getScoutSetupById(db, setupId)!;
    await interaction.editReply(buildScoutRosterReviewView(db, setupId, latest.version, listScoutRosterSlots(db, setupId), outcome === 'updated' ? 'Eligible signup seated.' : `No change was made (${outcome}).`));
    return true;
  }

  const sourceId = Number(selected);
  const source = slots.find((slot) => slot.id === sourceId);
  if (!source) return false;
  if (action === 'rolefirst') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`scout:editpick:roletarget:${setupId}:${expectedVersion}:${sourceId}`)
      .setPlaceholder('Second player to exchange')
      .addOptions(slots.filter((slot) => slot.id !== sourceId).map((slot) =>
        new StringSelectMenuOptionBuilder().setLabel(formatScoutSlotLabel(slot, names.get(slot.userId))).setValue(String(slot.id)),
      ));
    await interaction.editReply({ content: `Exchange ${formatScoutSlotLabel(source, names.get(source.userId))} with which occupied slot?`, components: [selectRow(menu)] });
    return true;
  }
  if (action === 'roletarget') {
    const originalSourceId = Number(parts[5]);
    const changed = swapScoutRosterSlotsIfVersion(
      db, setupId, expectedVersion, originalSourceId, sourceId, true, interaction.user.id,
    );
    const latest = getScoutSetupById(db, setupId)!;
    await interaction.editReply(buildScoutRosterReviewView(db, setupId, latest.version, listScoutRosterSlots(db, setupId), changed ? 'Role assignments exchanged and marked as staff overrides.' : 'That view was stale; no change was made.'));
    return true;
  }
  if (action === 'replacefirst') {
    const rostered = new Set(slots.map((slot) => slot.userId));
    const eligibleSignups = await eligibleScoutSignups(interaction.guild!, listScoutSignups(db, setupId), setup.eligibilityRoleId);
    const eligible = eligibleSignups
      .filter((signup) => (signup.role === source.role || signup.role === 'fill') && !rostered.has(signup.userId))
      .map((signup) => signup.userId)
      .filter((userId, index, all) => all.indexOf(userId) === index)
      .slice(0, 25);
    const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (eligible.length) {
      const candidateNames = await resolveScoutPlayerNames(interaction.guild!, eligible);
      components.push(selectRow(new StringSelectMenuBuilder()
        .setCustomId(`scout:editpick:eligible:${setupId}:${expectedVersion}:${sourceId}`)
        .setPlaceholder('Eligible signup replacement')
        .addOptions(eligible.map((userId) => new StringSelectMenuOptionBuilder().setLabel(candidateNames.get(userId)!).setValue(userId)))));
    }
    components.push(selectRow(new UserSelectMenuBuilder()
      .setCustomId(`scout:edituser:explicit:${setupId}:${expectedVersion}:${sourceId}`)
      .setPlaceholder('Or choose an explicit staff substitute')));
    await interaction.editReply({ content: `Choose who should take ${formatScoutSlotLabel(source, names.get(source.userId))}.`, components });
    return true;
  }
  return false;
}

async function handleScoutReviewUserSelectImpl(
  interaction: UserSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || parts[1] !== 'edituser' || parts[2] !== 'explicit') return false;
  const setupId = Number(parts[3]);
  const expectedVersion = Number(parts[4]);
  const slotId = Number(parts[5]);
  if (![setupId, expectedVersion, slotId].every(Number.isInteger)) return false;
  await interaction.deferUpdate();
  const setup = await authorized(interaction, db, setupId);
  if (!setup) {
    await interaction.editReply({ content: 'You do not have permission to edit this division roster.' });
    return true;
  }
  const selectedUserId = interaction.values[0]!;
  const selectedMember = await interaction.guild?.members.fetch(selectedUserId).catch(() => undefined);
  if (!selectedMember || interaction.users.get(selectedUserId)?.bot) {
    await interaction.editReply({ content: 'A bot cannot be used as a scout substitute.' });
    return true;
  }
  if (!isScoutUserEligible(selectedMember.roles.cache.keys(), setup.eligibilityRoleId)) {
    await interaction.editReply({ content: 'That player does not hold this setup\'s eligibility role.' });
    return true;
  }
  const outcome = replaceScoutRosterSlotIfVersion(
    db, setupId, expectedVersion, slotId, selectedUserId, true, interaction.user.id,
  );
  const latest = getScoutSetupById(db, setupId)!;
  await interaction.editReply(buildScoutRosterReviewView(db, setupId, latest.version, listScoutRosterSlots(db, setupId), outcome === 'updated' ? 'Staff substitute seated and marked as an override.' : `No change was made (${outcome}).`));
  return true;
}

export async function handleScoutReviewButton(interaction: ButtonInteraction, db: Database.Database): Promise<boolean> {
  const parts = interaction.customId.split(':');
  const setupId = Number(parts[['edit', 'editpick', 'edituser'].includes(parts[1] ?? '') ? 3 : 2]);
  const before = getScoutSetupById(db, setupId)?.version;
  try { return await handleScoutReviewButtonImpl(interaction, db); }
  finally {
    if (before !== undefined && getScoutSetupById(db, setupId)?.version !== before) {
      await refreshScoutStatusCardSafely(interaction.client, db, setupId);
    }
  }
}

export async function handleScoutReviewStringSelect(interaction: StringSelectMenuInteraction, db: Database.Database): Promise<boolean> {
  const parts = interaction.customId.split(':');
  const setupId = Number(parts[['edit', 'editpick', 'edituser'].includes(parts[1] ?? '') ? 3 : 2]);
  const before = getScoutSetupById(db, setupId)?.version;
  try { return await handleScoutReviewStringSelectImpl(interaction, db); }
  finally {
    if (before !== undefined && getScoutSetupById(db, setupId)?.version !== before) {
      await refreshScoutStatusCardSafely(interaction.client, db, setupId);
    }
  }
}

export async function handleScoutReviewUserSelect(interaction: UserSelectMenuInteraction, db: Database.Database): Promise<boolean> {
  const parts = interaction.customId.split(':');
  const setupId = Number(parts[['edit', 'editpick', 'edituser'].includes(parts[1] ?? '') ? 3 : 2]);
  const before = getScoutSetupById(db, setupId)?.version;
  try { return await handleScoutReviewUserSelectImpl(interaction, db); }
  finally {
    if (before !== undefined && getScoutSetupById(db, setupId)?.version !== before) {
      await refreshScoutStatusCardSafely(interaction.client, db, setupId);
    }
  }
}
