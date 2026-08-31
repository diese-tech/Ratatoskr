import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction } from 'discord.js';
import type Database from 'better-sqlite3';
import {
  getDivisionByKey,
  getScoutConfig,
  getScoutSetupById,
  listScoutRosterSlots,
  listScoutSignups,
  replaceScoutRosterIfVersion,
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

function rosterView(setupId: number, version: number, slots: ReturnType<typeof listScoutRosterSlots>, notice?: string) {
  const lines = [notice, '**Private scout roster review**'];
  for (const [index, team] of SCOUT_TEAMS.entries()) {
    lines.push('', `**Team ${index + 1}**`);
    for (const role of SCOUT_ROLES) {
      const slot = slots.find((candidate) => candidate.team === team && candidate.role === role);
      lines.push(`${SCOUT_ROLE_LABELS[role]}: ${slot ? `<@${slot.userId}>` : '_empty_'}`);
    }
  }
  return {
    content: lines.filter((line): line is string => Boolean(line)).join('\n'),
    allowedMentions: { parse: [] as never[] },
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`scout:shuffle:${setupId}:${version}`)
          .setLabel('Shuffle')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

async function authorized(interaction: ButtonInteraction, db: Database.Database, setupId: number) {
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

export async function handleScoutReviewButton(interaction: ButtonInteraction, db: Database.Database): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || !['review', 'shuffle'].includes(parts[1] ?? '')) return false;
  const setupId = Number(parts[2]);
  if (!Number.isInteger(setupId)) return false;
  const setup = await authorized(interaction, db, setupId);
  if (!setup) {
    await interaction.reply({ content: 'You do not have permission to review this division roster.', flags: MessageFlags.Ephemeral });
    return true;
  }

  if (parts[1] === 'review') {
    await interaction.reply({ ...rosterView(setup.id, setup.version, listScoutRosterSlots(db, setup.id)), flags: MessageFlags.Ephemeral });
    return true;
  }

  const expectedVersion = Number(parts[3]);
  if (!Number.isInteger(expectedVersion)) return false;
  const current = listScoutRosterSlots(db, setup.id);
  const signups = listScoutSignups(db, setup.id);
  const generated = generateDifferentScoutRoster(signups, scoutRosterFingerprint(current));
  if (!generated.result.feasible || !generated.isDifferent) {
    await interaction.update(rosterView(setup.id, setup.version, current, 'No different valid roster is available.'));
    return true;
  }
  if (!replaceScoutRosterIfVersion(db, setup.id, expectedVersion, generated.result.slots)) {
    const latest = getScoutSetupById(db, setup.id)!;
    await interaction.update(rosterView(setup.id, latest.version, listScoutRosterSlots(db, setup.id), 'That view was stale; showing the current roster.'));
    return true;
  }
  const updated = getScoutSetupById(db, setup.id)!;
  await interaction.update(rosterView(setup.id, updated.version, listScoutRosterSlots(db, setup.id), 'Roster shuffled.'));
  return true;
}
