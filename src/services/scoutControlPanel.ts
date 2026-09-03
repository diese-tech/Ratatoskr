import type { Client } from 'discord.js';
import type Database from 'better-sqlite3';
import { getScoutSetupById, type ScoutSetup } from '../db/index.js';
import { scoutReviewButtonRow } from './scoutReview.js';
import { refreshScoutStatusCard, reconcileScoutStatusCards } from './scoutCardLifecycle.js';

export function scoutControlPanelMarker(setupId: number): string {
  return `SCOUT-CONTROL-${setupId}`;
}

export function renderScoutControlPanelPrompt(setup: ScoutSetup, notifyCreator = true) {
  return {
    content: [
      `<@${setup.createdBy}>`,
      `**${setup.divisionDisplayName} roster ready — setup #${setup.id}**`,
      `Start: <t:${setup.startAt}:F>`,
      'Review and balance the roster here, then publish it to the division signup channel.',
      `\`${scoutControlPanelMarker(setup.id)}\``,
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
