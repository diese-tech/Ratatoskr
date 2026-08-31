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
  listScoutRosterSlots,
  listScoutSignups,
  replaceScoutRosterSlotIfVersion,
  replaceScoutRosterIfVersion,
  swapScoutRosterSlotsIfVersion,
  withdrawnScoutRosterUserIds,
} from '../db/index.js';
import {
  generateDifferentScoutRoster,
  scoutRosterFingerprint,
  SCOUT_ROLES,
  SCOUT_ROLE_LABELS,
  SCOUT_TEAMS,
} from '../domain/index.js';
import { hasScoutManagementAccess } from './scoutAuthorization.js';

export function scoutReviewButtonRow(setupId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`scout:review:${setupId}`)
      .setLabel('Review roster')
      .setStyle(ButtonStyle.Primary),
  );
}

export function buildScoutRosterReviewView(db: Database.Database, setupId: number, version: number, slots: ReturnType<typeof listScoutRosterSlots>, notice?: string) {
  const withdrawn = new Set(withdrawnScoutRosterUserIds(db, setupId));
  const lines = [notice, '**Private scout roster review**'];
  for (const [index, team] of SCOUT_TEAMS.entries()) {
    lines.push('', `**Team ${index + 1}**`);
    for (const role of SCOUT_ROLES) {
      const slot = slots.find((candidate) => candidate.team === team && candidate.role === role);
      const flags = slot ? `${slot.staffAssigned ? ' 🛠️' : ''}${withdrawn.has(slot.userId) ? ' ⚠️ signup withdrawn' : ''}` : '';
      lines.push(`${SCOUT_ROLE_LABELS[role]}: ${slot ? `<@${slot.userId}>${flags}` : '_empty_'}`);
    }
  }
  if (withdrawn.size) lines.push('', '⚠️ Publishing is blocked until every withdrawn signup is resolved.');
  return {
    content: lines.filter((line): line is string => Boolean(line)).join('\n'),
    allowedMentions: { parse: [] as never[] },
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`scout:shuffle:${setupId}:${version}`)
          .setLabel('Shuffle')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`scout:edit:swap:${setupId}:${version}`).setLabel('Swap teams').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`scout:edit:role:${setupId}:${version}`).setLabel('Change roles').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`scout:edit:replace:${setupId}:${version}`).setLabel('Replace slot').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`scout:publish:${setupId}:${version}`)
          .setLabel('Publish')
          .setStyle(ButtonStyle.Success)
          .setDisabled(withdrawn.size > 0),
      ),
    ],
  };
}

async function authorized(interaction: MessageComponentInteraction, db: Database.Database, setupId: number) {
  const setup = getScoutSetupById(db, setupId);
  if (!setup || setup.guildId !== interaction.guildId || setup.status !== 'roster_ready' || !interaction.guild) return undefined;
  const division = getDivisionByKey(db, setup.guildId, setup.divisionKey);
  if (!division || division.id !== setup.divisionId || division.status !== 'active') return undefined;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const config = getScoutConfig(db, setup.guildId);
  const { hasAccess } = await import('./authorization.js');
  const allowed = hasScoutManagementAccess({
    isAdmin: hasAccess(member, 'ADMIN'),
    memberRoleIds: new Set(member.roles.cache.keys()),
    additionalAuthorizedRoleIds: config?.authorizedRoleIds ?? [],
    divisionCaptainAccessRoleId: division.captainAccessRoleId,
  });
  return allowed ? setup : undefined;
}

function slotLabel(slot: ReturnType<typeof listScoutRosterSlots>[number]) {
  return `${slot.team === 'team_one' ? 'Team 1' : 'Team 2'} ${SCOUT_ROLE_LABELS[slot.role]} — ${slot.userId}`;
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
  if (action === 'swap') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`scout:editpick:swap:${setupId}:${version}`)
      .setPlaceholder('Role to swap between teams')
      .addOptions(SCOUT_ROLES.map((role) => new StringSelectMenuOptionBuilder().setLabel(SCOUT_ROLE_LABELS[role]).setValue(role)));
    await interaction.update({ content: 'Choose the role whose two players should swap teams.', components: [selectRow(menu)] });
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`scout:editpick:${action}first:${setupId}:${version}`)
    .setPlaceholder(action === 'role' ? 'First player to exchange' : 'Slot to replace')
    .addOptions(slots.map((slot) => new StringSelectMenuOptionBuilder().setLabel(slotLabel(slot).slice(0, 100)).setValue(String(slot.id))));
  await interaction.update({
    content: action === 'role' ? 'Choose the first occupied slot in the role exchange.' : 'Choose the roster slot to replace.',
    components: [selectRow(menu)],
  });
}

export async function handleScoutReviewButton(interaction: ButtonInteraction, db: Database.Database): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || !['review', 'shuffle', 'edit'].includes(parts[1] ?? '')) return false;
  const editing = parts[1] === 'edit';
  const setupId = Number(parts[editing ? 3 : 2]);
  if (!Number.isInteger(setupId)) return false;
  const setup = await authorized(interaction, db, setupId);
  if (!setup) {
    await interaction.reply({ content: 'You do not have permission to review this division roster.', flags: MessageFlags.Ephemeral });
    return true;
  }

  if (parts[1] === 'review') {
    await interaction.reply({ ...buildScoutRosterReviewView(db, setup.id, setup.version, listScoutRosterSlots(db, setup.id)), flags: MessageFlags.Ephemeral });
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
  const signups = listScoutSignups(db, setup.id);
  const generated = generateDifferentScoutRoster(signups, scoutRosterFingerprint(current));
  if (!generated.result.feasible || !generated.isDifferent) {
    await interaction.update(buildScoutRosterReviewView(db, setup.id, setup.version, current, 'No different valid roster is available.'));
    return true;
  }
  if (!replaceScoutRosterIfVersion(db, setup.id, expectedVersion, generated.result.slots)) {
    const latest = getScoutSetupById(db, setup.id)!;
    await interaction.update(buildScoutRosterReviewView(db, setup.id, latest.version, listScoutRosterSlots(db, setup.id), 'That view was stale; showing the current roster.'));
    return true;
  }
  const updated = getScoutSetupById(db, setup.id)!;
  await interaction.update(buildScoutRosterReviewView(db, setup.id, updated.version, listScoutRosterSlots(db, setup.id), 'Roster shuffled.'));
  return true;
}

export async function handleScoutReviewStringSelect(
  interaction: StringSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || parts[1] !== 'editpick') return false;
  const action = parts[2] ?? '';
  const setupId = Number(parts[3]);
  const expectedVersion = Number(parts[4]);
  if (!Number.isInteger(setupId) || !Number.isInteger(expectedVersion)) return false;
  const setup = await authorized(interaction, db, setupId);
  if (!setup) {
    await interaction.reply({ content: 'You do not have permission to edit this division roster.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const selected = interaction.values[0];
  const slots = listScoutRosterSlots(db, setupId);

  if (action === 'swap') {
    const pair = slots.filter((slot) => slot.role === selected);
    const changed = pair.length === 2 && swapScoutRosterSlotsIfVersion(db, setupId, expectedVersion, pair[0]!.id, pair[1]!.id, false);
    const latest = getScoutSetupById(db, setupId)!;
    await interaction.update(buildScoutRosterReviewView(db, setupId, latest.version, listScoutRosterSlots(db, setupId), changed ? 'Players swapped between teams.' : 'That view was stale; no change was made.'));
    return true;
  }

  if (action === 'eligible') {
    const slotId = Number(parts[5]);
    const slot = slots.find((candidate) => candidate.id === slotId);
    const stillEligible = slot && listScoutSignups(db, setupId).some(
      (signup) => signup.userId === selected && signup.role === slot.role,
    );
    if (!stillEligible) {
      await interaction.update(buildScoutRosterReviewView(db, setupId, setup.version, slots, 'That player is no longer an eligible signup for this slot.'));
      return true;
    }
    const outcome = replaceScoutRosterSlotIfVersion(db, setupId, expectedVersion, slotId, selected!, false);
    const latest = getScoutSetupById(db, setupId)!;
    await interaction.update(buildScoutRosterReviewView(db, setupId, latest.version, listScoutRosterSlots(db, setupId), outcome === 'updated' ? 'Eligible signup seated.' : `No change was made (${outcome}).`));
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
        new StringSelectMenuOptionBuilder().setLabel(slotLabel(slot).slice(0, 100)).setValue(String(slot.id)),
      ));
    await interaction.update({ content: `Exchange ${slotLabel(source)} with which occupied slot?`, components: [selectRow(menu)] });
    return true;
  }
  if (action === 'roletarget') {
    const originalSourceId = Number(parts[5]);
    const changed = swapScoutRosterSlotsIfVersion(db, setupId, expectedVersion, originalSourceId, sourceId, true);
    const latest = getScoutSetupById(db, setupId)!;
    await interaction.update(buildScoutRosterReviewView(db, setupId, latest.version, listScoutRosterSlots(db, setupId), changed ? 'Role assignments exchanged and marked as staff overrides.' : 'That view was stale; no change was made.'));
    return true;
  }
  if (action === 'replacefirst') {
    const rostered = new Set(slots.map((slot) => slot.userId));
    const eligible = listScoutSignups(db, setupId)
      .filter((signup) => signup.role === source.role && !rostered.has(signup.userId))
      .map((signup) => signup.userId)
      .filter((userId, index, all) => all.indexOf(userId) === index)
      .slice(0, 25);
    const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (eligible.length) {
      components.push(selectRow(new StringSelectMenuBuilder()
        .setCustomId(`scout:editpick:eligible:${setupId}:${expectedVersion}:${sourceId}`)
        .setPlaceholder('Eligible signup replacement')
        .addOptions(eligible.map((userId) => new StringSelectMenuOptionBuilder().setLabel(userId).setValue(userId)))));
    }
    components.push(selectRow(new UserSelectMenuBuilder()
      .setCustomId(`scout:edituser:explicit:${setupId}:${expectedVersion}:${sourceId}`)
      .setPlaceholder('Or choose an explicit staff substitute')));
    await interaction.update({ content: `Choose who should take ${slotLabel(source)}.`, components });
    return true;
  }
  return false;
}

export async function handleScoutReviewUserSelect(
  interaction: UserSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || parts[1] !== 'edituser' || parts[2] !== 'explicit') return false;
  const setupId = Number(parts[3]);
  const expectedVersion = Number(parts[4]);
  const slotId = Number(parts[5]);
  if (![setupId, expectedVersion, slotId].every(Number.isInteger)) return false;
  const setup = await authorized(interaction, db, setupId);
  if (!setup) {
    await interaction.reply({ content: 'You do not have permission to edit this division roster.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const selectedUserId = interaction.values[0]!;
  if (interaction.users.get(selectedUserId)?.bot) {
    await interaction.reply({ content: 'A bot cannot be used as a scout substitute.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const outcome = replaceScoutRosterSlotIfVersion(db, setupId, expectedVersion, slotId, selectedUserId, true);
  const latest = getScoutSetupById(db, setupId)!;
  await interaction.update(buildScoutRosterReviewView(db, setupId, latest.version, listScoutRosterSlots(db, setupId), outcome === 'updated' ? 'Staff substitute seated and marked as an override.' : `No change was made (${outcome}).`));
  return true;
}
