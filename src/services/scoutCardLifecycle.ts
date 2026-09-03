import { RESTJSONErrorCodes, type Client, type Message, type TextBasedChannel } from 'discord.js';
import type Database from 'better-sqlite3';
import { getScoutSetupById, ensureScoutReadinessCard, patchScoutReadinessCard,
  readScoutReadinessSnapshot, listScoutReadinessSetupIds, type ScoutSetup } from '../db/index.js';
import { renderScoutReadiness } from '../domain/scoutReadiness.js';
import { captureScoutReadiness } from './scoutReadiness.js';
import { scoutReviewButtonRow } from './scoutReview.js';
import { reportOperationalError, operationalErrorGuidance } from './operationalErrors.js';

const locks = new WeakMap<Database.Database, Map<number, Promise<void>>>();
async function withCardLock<T>(db: Database.Database, setupId: number, action: () => Promise<T>): Promise<T> {
  let entries = locks.get(db);
  if (!entries) { entries = new Map(); locks.set(db, entries); }
  const previous = entries.get(setupId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  entries.set(setupId, tail);
  await previous;
  try { return await action(); }
  finally { release(); if (entries.get(setupId) === tail) entries.delete(setupId); }
}

export function scoutCardMarker(setupId: number, kind: 'telemetry' | 'control'): string {
  return kind === 'telemetry' ? `SCOUT-TELEMETRY-${setupId}` : `SCOUT-CONTROL-${setupId}`;
}
const missingMessage = (error: unknown) => Number((error as { code?: number })?.code) === 10008;
// These API responses reject message creation. Transport errors and unknown
// responses retain the attempt marker because delivery may still have occurred.
const rejectedSend = (error: unknown) => new Set<number>([
  RESTJSONErrorCodes.UnknownChannel, RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions, RESTJSONErrorCodes.InvalidFormBodyOrContentType,
]).has(Number((error as { code?: number })?.code));
const exactMarker = (content: string, marker: string) => content.split('\n').some((line) => line.trim() === `\`${marker}\`` || line.trim() === marker);

async function getMessage(channel: TextBasedChannel, messageId: string): Promise<Message | undefined> {
  try { return await channel.messages.fetch(messageId); }
  catch (error) { if (missingMessage(error)) return undefined; throw error; }
}

async function findCard(channel: TextBasedChannel, botId: string, marker: string): Promise<Message | undefined> {
  let before: string | undefined;
  while (true) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const found = page.find((message) => message.author.id === botId && exactMarker(message.content, marker));
    if (found || page.size < 100) return found;
    before = page.last()?.id;
    if (!before) throw new Error('Could not finish Scout card history lookup.');
  }
}

function cardView(db: Database.Database, setup: ScoutSetup, kind: 'telemetry' | 'control', notify: boolean, unavailable?: string) {
  const saved = readScoutReadinessSnapshot(ensureScoutReadinessCard(db, setup.id));
  const terminal = ['published', 'cancelled'].includes(setup.status);
  const status = setup.status === 'open' ? 'collecting signups' : setup.status === 'roster_ready' ? 'roster ready'
    : setup.status === 'published' ? 'published' : 'cancelled';
  const readiness = saved ? renderScoutReadiness(saved, terminal || Boolean(unavailable)) : 'No readiness snapshot was recorded.';
  return { content: [
    kind === 'control' ? `<@${setup.createdBy}>` : '',
    `**${setup.divisionDisplayName} ${status} — setup #${setup.id}**`,
    `Start: <t:${setup.startAt}:F> • <t:${setup.startAt}:R>`,
    setup.eligibilityRoleId ? `Eligibility: <@&${setup.eligibilityRoleId}>` : '',
    unavailable ? `⚠️ Live readiness could not be verified. ${unavailable}` : '',
    readiness,
    setup.status === 'roster_ready' ? 'Review and balance the roster here, then publish it to the signup channel.' : '',
    setup.status === 'published' && setup.resultMessageId
      ? `Roster: https://discord.com/channels/${setup.guildId}/${setup.resultsChannelId}/${setup.resultMessageId}`
      : setup.signupMessageId ? `Signup: https://discord.com/channels/${setup.guildId}/${setup.signupChannelId}/${setup.signupMessageId}` : '',
    `\`${scoutCardMarker(setup.id, kind)}\``,
  ].filter(Boolean).join('\n'),
  components: setup.status === 'roster_ready' && kind === 'control' ? [scoutReviewButtonRow(setup.id, setup.version)] : [],
  allowedMentions: { parse: [] as never[], users: notify ? [setup.createdBy] : [], roles: [] as string[] } };
}

async function editCard(message: Message, view: ReturnType<typeof cardView>): Promise<void> {
  if (message.content === view.content && JSON.stringify(message.components) === JSON.stringify(view.components)) return;
  await message.edit(view);
}

/** One serialized writer for temporary status, ready controls and terminal cards. */
export async function refreshScoutStatusCard(client: Client, db: Database.Database, setupId: number): Promise<'created' | 'recovered' | 'existing' | 'not_ready'> {
  return withCardLock(db, setupId, async () => {
    let outcome: 'created' | 'recovered' | 'existing' = 'existing';
    // Open -> ready -> terminal can happen while Discord work is in flight.
    // Re-read the lifecycle before deciding which card must remain visible.
    for (let transition = 0; transition < 4; transition++) {
      let setup = getScoutSetupById(db, setupId);
      if (!setup?.operationsChannelId || !client.user || !['open', 'roster_ready', 'published', 'cancelled'].includes(setup.status)) return 'not_ready';
      const previousStatus = setup.status;
      const channel = await client.channels.fetch(setup.operationsChannelId);
      if (!channel?.isTextBased() || !channel.isSendable() || !('guildId' in channel) || channel.guildId !== setup.guildId) {
        throw new Error('The snapshotted Scout Ops channel is unavailable or belongs to another guild.');
      }
      let state = ensureScoutReadinessCard(db, setupId);
      let unavailable: string | undefined;
      if (['open', 'roster_ready'].includes(setup.status)) {
        try {
          const currentSnapshot = await captureScoutReadiness(client, db, setup);
          const previousSnapshot = readScoutReadinessSnapshot(state);
          if (previousSnapshot && JSON.stringify({ ...currentSnapshot, recordedAt: 0 }) === JSON.stringify({ ...previousSnapshot, recordedAt: 0 })) {
            currentSnapshot.recordedAt = previousSnapshot.recordedAt;
          }
          if (getScoutSetupById(db, setupId)?.status === setup.status) {
            patchScoutReadinessCard(db, setupId, { snapshot_json: JSON.stringify(currentSnapshot) });
          }
        } catch (error) {
          const report = await reportOperationalError(client, db, { guildId: setup.guildId, setupId,
            division: setup.divisionDisplayName, action: 'Scout readiness eligibility' }, error);
          unavailable = operationalErrorGuidance(report);
        }
        setup = getScoutSetupById(db, setupId)!;
        if (setup.status !== previousStatus) continue;
      }
      let telemetry = state.telemetry_message_id ? await getMessage(channel, state.telemetry_message_id) : undefined;
      if (!telemetry && !state.telemetry_message_id) telemetry = await findCard(channel, client.user.id, scoutCardMarker(setupId, 'telemetry'));
      if (telemetry && !state.telemetry_message_id) {
        patchScoutReadinessCard(db, setupId, { telemetry_message_id: telemetry.id, telemetry_attempted: 1 });
        state = ensureScoutReadinessCard(db, setupId);
      }
      if (setup.status !== 'open') {
        // A lost send response could still materialize a temporary message.
        if (!telemetry && state.telemetry_attempted && !state.telemetry_message_id) throw new Error('Scout telemetry send is uncertain; retain its marker before creating a ready panel.');
        if (telemetry) {
          if (setup.status === 'cancelled' && !setup.controlMessageId) {
            await editCard(telemetry, cardView(db, setup, 'telemetry', false));
            return outcome;
          }
          try { await telemetry.delete(); } catch (error) { if (!missingMessage(error)) throw error; }
        }
        patchScoutReadinessCard(db, setupId, { telemetry_message_id: null, telemetry_attempted: 0 });
      } else {
        if (!telemetry) {
          if (state.telemetry_attempted && !state.telemetry_message_id) throw new Error('Scout telemetry send is uncertain; waiting for marker recovery.');
          patchScoutReadinessCard(db, setupId, { telemetry_attempted: 1, telemetry_message_id: null });
          try { telemetry = await channel.send(cardView(db, setup, 'telemetry', false, unavailable)); }
          catch (error) {
            if (rejectedSend(error)) patchScoutReadinessCard(db, setupId, { telemetry_attempted: 0 });
            throw error;
          }
          patchScoutReadinessCard(db, setupId, { telemetry_message_id: telemetry.id });
          outcome = 'created';
        } else await editCard(telemetry, cardView(db, setup, 'telemetry', false, unavailable));
        if (getScoutSetupById(db, setupId)?.status !== setup.status) continue;
        return outcome;
      }
      setup = getScoutSetupById(db, setupId)!;
      state = ensureScoutReadinessCard(db, setupId);
      let control = setup.controlMessageId ? await getMessage(channel, setup.controlMessageId) : undefined;
      if (!control) control = await findCard(channel, client.user.id, scoutCardMarker(setupId, 'control'));
      if (!control) {
        if (state.control_attempted && !setup.controlMessageId) throw new Error('Scout ready-panel send is uncertain; waiting for marker recovery.');
        // An open setup cancelled before its first card has nothing to notify.
        const notify = setup.status === 'roster_ready' && !state.creator_notification_attempted;
        // A deleted older card is proven absent; clear its ID before attempting
        // a replacement so a lost replacement response cannot lead to resends.
        if (setup.controlMessageId) db.prepare('UPDATE scout_setups SET control_message_id = NULL WHERE id = ?').run(setupId);
        patchScoutReadinessCard(db, setupId, { control_attempted: 1,
          creator_notification_attempted: notify ? 1 : state.creator_notification_attempted });
        try { control = await channel.send(cardView(db, setup, 'control', notify, unavailable)); }
        catch (error) {
          if (rejectedSend(error)) patchScoutReadinessCard(db, setupId, {
            control_attempted: 0, creator_notification_attempted: state.creator_notification_attempted,
          });
          throw error;
        }
        outcome = 'created';
      } else {
        outcome = setup.controlMessageId === control.id ? outcome : 'recovered';
        await editCard(control, cardView(db, setup, 'control', false, unavailable));
      }
      db.prepare('UPDATE scout_setups SET control_message_id = ? WHERE id = ?').run(control.id, setupId);
      patchScoutReadinessCard(db, setupId, { control_attempted: 1 });
      if (getScoutSetupById(db, setupId)?.status !== setup.status) continue;
      return outcome;
    }
    throw new Error('Scout card changed repeatedly; retry reconciliation.');
  });
}

export async function refreshScoutStatusCardSafely(client: Client, db: Database.Database, setupId: number): Promise<boolean> {
  try { await refreshScoutStatusCard(client, db, setupId); return true; }
  catch (error) {
    const setup = getScoutSetupById(db, setupId);
    if (setup) await reportOperationalError(client, db, { guildId: setup.guildId, setupId,
      division: setup.divisionDisplayName, action: 'Scout readiness card recovery' }, error);
    return false;
  }
}

export async function reconcileScoutStatusCards(client: Client, db: Database.Database): Promise<void> {
  for (const id of listScoutReadinessSetupIds(db)) await refreshScoutStatusCardSafely(client, db, id);
}
