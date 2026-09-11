import type { Client } from 'discord.js';
import type Database from 'better-sqlite3';
import { getScoutSetupById, type ScoutSetup } from '../db/index.js';
import { scoutReviewButtonRow } from './scoutReview.js';
import { refreshScoutStatusCard, reconcileScoutStatusCards } from './scoutCardCompatibility.js';

export function renderScoutControlPanelPrompt(setup: ScoutSetup, notifyCreator = true) {
  return {
    content: [
      `<@${setup.createdBy}>`,
      `**${setup.divisionDisplayName} Scout roster ready**`,
      `Start: <t:${setup.startAt}:F>`,
      'Review and balance the roster here, then publish it to the division signup channel.',
    ].join('\n'),
    components: [scoutReviewButtonRow(setup.id)],
    allowedMentions: { parse: [] as never[], users: notifyCreator ? [setup.createdBy] : [], roles: [] as string[] },
  };
}

export async function ensureScoutControlPanel(client: Client, db: Database.Database, setupId: number) {
  if (getScoutSetupById(db, setupId)?.status !== 'roster_ready') return 'not_ready' as const;
  return refreshScoutStatusCard(client, db, setupId);
}

export const reconcileScoutControlPanels = reconcileScoutStatusCards;
