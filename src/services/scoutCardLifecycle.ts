import { RESTJSONErrorCodes, type Client, type Message, type TextBasedChannel } from 'discord.js';
import type { ScoutSetup } from '../db/types.js';
import { renderScoutReadiness, type ScoutReadinessSnapshot } from '../domain/scoutReadiness.js';
import { SCOUT_ROLE_LABELS } from '../domain/index.js';
import type { ScoutReadinessCardStore } from '../storage/index.js';
import { captureScoutReadinessDetails } from './scoutReadiness.js';
import { buildScoutWorkingRosterView } from './scoutReview.js';
import type { ScoutSignupEligibility } from './scoutEligibility.js';
import { scoutCancelButtonRow } from './scoutCancel.js';
import { managementRow, scoutResultLinkRow } from './scoutPublish.js';
import { scoutFinishButtonRow } from './scoutFinish.js';
import { operationalErrorGuidance, type OperationContext } from './operationalErrors.js';

export type ScoutCardDependencies = {
  storage: ScoutReadinessCardStore;
  operationScope: object;
  reportError: (
    client: Client,
    context: OperationContext,
    error: unknown,
  ) => Promise<{ reference: string; staffDelivered: boolean }>;
};

const locks = new WeakMap<object, Map<number, Promise<void>>>();
async function withCardLock<T>(scope: object, setupId: number, action: () => Promise<T>): Promise<T> {
  let entries = locks.get(scope);
  if (!entries) { entries = new Map(); locks.set(scope, entries); }
  const previous = entries.get(setupId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  entries.set(setupId, tail);
  await previous;
  try { return await action(); }
  finally { release(); if (entries.get(setupId) === tail) entries.delete(setupId); }
}

function readScoutReadinessSnapshot(snapshotJson: string | null): ScoutReadinessSnapshot | undefined {
  return snapshotJson ? JSON.parse(snapshotJson) as ScoutReadinessSnapshot : undefined;
}

const missingMessage = (error: unknown) => Number((error as { code?: number })?.code) === 10008;
// These API responses reject message creation. Transport errors and unknown
// responses retain the attempt marker because delivery may still have occurred.
const rejectedSend = (error: unknown) => new Set<number>([
  RESTJSONErrorCodes.UnknownChannel, RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions, RESTJSONErrorCodes.InvalidFormBodyOrContentType,
]).has(Number((error as { code?: number })?.code));
function hasSetupScopedControl(message: Message, setupId: number): boolean {
  const serialized = JSON.stringify(message.components);
  return new RegExp(`scout:(?:[^\"\\\\:]+:){1,3}${setupId}(?::|\")`).test(serialized);
}

async function getMessage(channel: TextBasedChannel, messageId: string): Promise<Message | undefined> {
  try { return await channel.messages.fetch(messageId); }
  catch (error) { if (missingMessage(error)) return undefined; throw error; }
}

async function findCard(channel: TextBasedChannel, botId: string, setupId: number): Promise<Message | undefined> {
  let before: string | undefined;
  while (true) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const found = page.find((message) => message.author.id === botId && hasSetupScopedControl(message, setupId));
    if (found || page.size < 100) return found;
    before = page.last()?.id;
    if (!before) throw new Error('Could not finish Scout card history lookup.');
  }
}

async function cardView(
  storage: ScoutReadinessCardStore,
  setup: ScoutSetup,
  kind: 'telemetry' | 'control',
  notify: boolean,
  unavailable?: string,
  signupEligibility?: ScoutSignupEligibility,
) {
  const completion = await storage.getCompletion(setup.id);
  if (completion) {
    return {
      content: [
        `**✓ ${setup.divisionDisplayName} Scout finished**`,
        `<t:${setup.startAt}:t>`,
        `Finished by <@${completion.finished_by}> at <t:${Math.floor(Date.parse(completion.finished_at) / 1000)}:F>.`,
        completion.posts_reconciled ? '' : 'Discord post cleanup is pending. Retry after access is restored.',
      ].filter(Boolean).join('\n'),
      components: completion.posts_reconciled
        ? [scoutResultLinkRow(setup, 'View final roster')]
        : [scoutResultLinkRow(setup, 'View final roster'), scoutFinishButtonRow(setup.id, setup.version, true)],
      allowedMentions: { parse: [] as never[], users: [] as string[], roles: [] as string[] },
    };
  }
  if (['open', 'roster_ready'].includes(setup.status)) {
    const [withdrawnUserIds, slots, persistedSignups] = await Promise.all([
      storage.listWithdrawnUserIds(setup.id),
      storage.listRosterSlots(setup.id),
      signupEligibility ? Promise.resolve([]) : storage.listSignups(setup.id),
    ]);
    const unavailableUsers = new Set(withdrawnUserIds);
    const prefixes = [
      notify ? `<@${setup.createdBy}>` : '',
      unavailable ? `⚠️ Live eligibility could not be verified. ${unavailable}` : '',
    ].filter(Boolean);
    const prefixLength = prefixes.join('\n').length + (prefixes.length ? 1 : 0);
    const view = buildScoutWorkingRosterView(
      setup,
      slots,
      signupEligibility?.eligibleSignups ?? persistedSignups,
      unavailableUsers,
      signupEligibility?.ineligibleSignups,
      2_000 - prefixLength,
    );
    return {
      ...view,
      content: [...prefixes, view.content].join('\n'),
      allowedMentions: { parse: [] as never[], users: notify ? [setup.createdBy] : [], roles: [] as string[] },
    };
  }
  if (setup.status === 'published' && setup.resultMessageId) {
    const replacementSlots = (await storage.listRosterSlots(setup.id)).filter((slot) => slot.replacementNeeded);
    return {
      content: replacementSlots.length
        ? [
          `**⚠️ ${setup.divisionDisplayName} Scout · replacement needed**`,
          `<t:${setup.startAt}:t> · ${replacementSlots.map((slot) => `${setup.gameCount === 2 ? `Game ${slot.gameNumber} · ` : ''}${slot.team === 'team_one' ? 'Order' : 'Chaos'} ${SCOUT_ROLE_LABELS[slot.role]}`).join(', ')}`,
        ].join('\n')
        : `**✓ ${setup.divisionDisplayName} Scout filled**\n<t:${setup.startAt}:t>`,
      components: [scoutResultLinkRow(setup), scoutFinishButtonRow(setup.id, setup.version)],
      allowedMentions: { parse: [] as never[], users: [] as string[], roles: [] as string[] },
    };
  }
  const saved = readScoutReadinessSnapshot((await storage.ensureCard(setup.id)).snapshot_json);
  const terminal = ['published', 'cancelled'].includes(setup.status);
  const status = setup.status === 'open' ? 'collecting signups' : setup.status === 'roster_ready' ? 'roster ready'
    : setup.status === 'published' ? 'published' : 'cancelled';
  const readiness = saved ? renderScoutReadiness(saved, terminal || Boolean(unavailable)) : 'No readiness snapshot was recorded.';
  return { content: [
    kind === 'control' ? `<@${setup.createdBy}>` : '',
    `**${setup.divisionDisplayName} Scout ${status}**`,
    `Start: <t:${setup.startAt}:F> • <t:${setup.startAt}:R>`,
    setup.eligibilityRoleId ? `Eligibility: <@&${setup.eligibilityRoleId}>` : '',
    unavailable ? `⚠️ Live readiness could not be verified. ${unavailable}` : '',
    readiness,
    setup.status === 'cancelled' && !setup.signupPostReconciled ? 'Cancelled in the records; public post cleanup is pending. Use Retry post cleanup after access is restored.' : '',
    setup.status === 'roster_ready' ? 'Review and balance the roster here, then publish it to the signup channel.' : '',
    setup.status === 'published' && setup.resultMessageId
      ? `Roster: https://discord.com/channels/${setup.guildId}/${setup.resultsChannelId}/${setup.resultMessageId}`
      : setup.signupMessageId ? `Signup: https://discord.com/channels/${setup.guildId}/${setup.signupChannelId}/${setup.signupMessageId}` : '',
  ].filter(Boolean).join('\n'),
  components: setup.status === 'cancelled' && !setup.signupPostReconciled ? [scoutCancelButtonRow(setup.id, setup.version, true)]
    : setup.status === 'published' ? [managementRow(setup.id, setup.version), scoutFinishButtonRow(setup.id, setup.version)]
    : setup.status === 'open' ? [scoutCancelButtonRow(setup.id, setup.version)]
    : [],
  allowedMentions: { parse: [] as never[], users: notify ? [setup.createdBy] : [], roles: [] as string[] } };
}

async function editCard(message: Message, view: Awaited<ReturnType<typeof cardView>>): Promise<void> {
  if (message.content === view.content && JSON.stringify(message.components) === JSON.stringify(view.components)) return;
  await message.edit(view);
}

/** One serialized writer for temporary status, ready controls and terminal cards. */
export async function refreshScoutStatusCard(
  client: Client,
  dependencies: ScoutCardDependencies,
  setupId: number,
): Promise<'created' | 'recovered' | 'existing' | 'not_ready'> {
  const { storage } = dependencies;
  return withCardLock(dependencies.operationScope, setupId, async () => {
    let outcome: 'created' | 'recovered' | 'existing' = 'existing';
    // Open -> ready -> terminal can happen while Discord work is in flight.
    // Re-read the lifecycle before deciding which card must remain visible.
    for (let transition = 0; transition < 4; transition++) {
      let setup = await storage.getSetup(setupId);
      if (!setup?.operationsChannelId || !client.user || !['open', 'roster_ready', 'published', 'cancelled'].includes(setup.status)) return 'not_ready';
      const previousStatus = setup.status;
      const channel = await client.channels.fetch(setup.operationsChannelId);
      if (!channel?.isTextBased() || !channel.isSendable() || !('guildId' in channel) || channel.guildId !== setup.guildId) {
        throw new Error('The snapshotted Scout Ops channel is unavailable or belongs to another guild.');
      }
      let state = await storage.ensureCard(setupId);
      let unavailable: string | undefined;
      let signupEligibility: ScoutSignupEligibility | undefined;
      if (['open', 'roster_ready'].includes(setup.status)) {
        try {
          const readiness = await captureScoutReadinessDetails(client, storage, setup);
          signupEligibility = readiness;
          const currentSnapshot = readiness.snapshot;
          const previousSnapshot = readScoutReadinessSnapshot(state.snapshot_json);
          if (previousSnapshot && JSON.stringify({ ...currentSnapshot, recordedAt: 0 }) === JSON.stringify({ ...previousSnapshot, recordedAt: 0 })) {
            currentSnapshot.recordedAt = previousSnapshot.recordedAt;
          }
          await storage.patchSnapshotIfStatus(setupId, setup.status, JSON.stringify(currentSnapshot));
        } catch (error) {
          const report = await dependencies.reportError(client, { guildId: setup.guildId, setupId,
            division: setup.divisionDisplayName, action: 'Scout readiness eligibility' }, error);
          unavailable = operationalErrorGuidance(report);
        }
        setup = (await storage.getSetup(setupId))!;
        if (setup.status !== previousStatus) continue;
      }
      let telemetry = state.telemetry_message_id ? await getMessage(channel, state.telemetry_message_id) : undefined;
      if (!telemetry && !state.telemetry_message_id) telemetry = await findCard(channel, client.user.id, setupId);
      if (telemetry && !state.telemetry_message_id) {
        await storage.patchCard(setupId, { telemetry_message_id: telemetry.id, telemetry_attempted: 1 });
        state = await storage.ensureCard(setupId);
      }
      if (setup.status !== 'open') {
        // A lost send response could still materialize a temporary message.
        if (!telemetry && state.telemetry_attempted && !state.telemetry_message_id) throw new Error('Scout telemetry send is uncertain; retain its marker before creating a ready panel.');
        if (telemetry && !setup.controlMessageId) {
          if (!await storage.promoteTelemetryToControl(setupId, telemetry.id)) continue;
          setup = (await storage.getSetup(setupId))!;
        } else if (telemetry && setup.controlMessageId !== telemetry.id) {
          if (setup.status === 'cancelled' && !setup.controlMessageId) {
            await editCard(telemetry, await cardView(storage, setup, 'telemetry', false));
            return outcome;
          }
          try { await telemetry.delete(); } catch (error) { if (!missingMessage(error)) throw error; }
        }
        await storage.patchCard(setupId, { telemetry_message_id: null, telemetry_attempted: 0 });
      } else {
        if (!telemetry) {
          if (state.telemetry_attempted && !state.telemetry_message_id) throw new Error('Scout telemetry send is uncertain; waiting for marker recovery.');
          await storage.patchCard(setupId, { telemetry_attempted: 1, telemetry_message_id: null });
          try { telemetry = await channel.send(await cardView(storage, setup, 'telemetry', false, unavailable, signupEligibility)); }
          catch (error) {
            if (rejectedSend(error)) await storage.patchCard(setupId, { telemetry_attempted: 0 });
            throw error;
          }
          await storage.patchCard(setupId, { telemetry_message_id: telemetry.id });
          outcome = 'created';
        } else await editCard(telemetry, await cardView(storage, setup, 'telemetry', false, unavailable, signupEligibility));
        if ((await storage.getSetup(setupId))?.status !== setup.status) continue;
        return outcome;
      }
      setup = (await storage.getSetup(setupId))!;
      state = await storage.ensureCard(setupId);
      let control = setup.controlMessageId ? await getMessage(channel, setup.controlMessageId) : undefined;
      if (!control) control = await findCard(channel, client.user.id, setupId);
      if (!control) {
        if (state.control_attempted && !setup.controlMessageId) throw new Error('Scout ready-panel send is uncertain; waiting for marker recovery.');
        // An open setup cancelled before its first card has nothing to notify.
        const notify = setup.status === 'roster_ready' && !state.creator_notification_attempted;
        // A deleted older card is proven absent; clear its ID before attempting
        // a replacement so a lost replacement response cannot lead to resends.
        if (setup.controlMessageId && !await storage.clearControlMessage(setupId, setup.controlMessageId)) continue;
        await storage.patchCard(setupId, { control_attempted: 1,
          creator_notification_attempted: notify ? 1 : state.creator_notification_attempted });
        try { control = await channel.send(await cardView(storage, setup, 'control', notify, unavailable, signupEligibility)); }
        catch (error) {
          if (rejectedSend(error)) await storage.patchCard(setupId, {
            control_attempted: 0, creator_notification_attempted: state.creator_notification_attempted,
          });
          throw error;
        }
        outcome = 'created';
      } else {
        outcome = setup.controlMessageId === control.id ? outcome : 'recovered';
        await editCard(control, await cardView(storage, setup, 'control', false, unavailable, signupEligibility));
      }
      if (!await storage.confirmControlMessage(setupId, control.id)) continue;
      if ((await storage.getSetup(setupId))?.status !== setup.status) continue;
      return outcome;
    }
    throw new Error('Scout card changed repeatedly; retry reconciliation.');
  });
}

export async function refreshScoutStatusCardSafely(
  client: Client,
  dependencies: ScoutCardDependencies,
  setupId: number,
): Promise<boolean> {
  try { await refreshScoutStatusCard(client, dependencies, setupId); return true; }
  catch (error) {
    const setup = await dependencies.storage.getSetup(setupId);
    if (setup) await dependencies.reportError(client, { guildId: setup.guildId, setupId,
      division: setup.divisionDisplayName, action: 'Scout readiness card recovery' }, error);
    return false;
  }
}

export async function reconcileScoutStatusCards(
  client: Client,
  dependencies: ScoutCardDependencies,
): Promise<void> {
  for (const id of await dependencies.storage.listSetupIds()) {
    await refreshScoutStatusCardSafely(client, dependencies, id);
  }
}
