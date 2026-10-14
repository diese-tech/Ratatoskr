import { redactOperationalText } from './redactOperationalText.js';
export { redactOperationalText } from './redactOperationalText.js';
import { createHash, randomUUID } from 'node:crypto';
import { ChannelType, PermissionFlagsBits, escapeMarkdown, type Client, type GuildTextBasedChannel } from 'discord.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getActiveManagedResourceByLogicalKey } from '../db/index.js';
import { serverChannelLogicalKey, serverRoleLogicalKey } from './serverBootstrap.js';
import { LEGACY_YSL_VALKYRIE_ROLE_ID } from '../config/staff-role-ids.js';

export type OperationContext = { guildId: string; action: string; setupId?: number; division?: string; next?: string };
type OperationalDetails = {
  code: string;
  summary: string;
  next: string;
  noChanges: boolean;
};
type Report = { reference: string; staffDelivered: boolean; details?: OperationalDetails };
const recent = new WeakMap<Database.Database, Map<string, Report & { at: number }>>();

// Optional escape hatch for when the guild's staff-ops channel exists but
// isn't (yet) a Ratatoskr-managed resource -- e.g. it lives under a category
// server bootstrap doesn't recognize, so adoption is correctly refused as
// ambiguous. Setting this lets operational alerts reach staff without
// running server bootstrap (which reconciles permissions across the whole
// scaffold) just to register one channel. Validated separately from
// src/config/env.ts, like ROLE_ALLFATHER_ID/ROLE_AESIR_ID in
// authorization.ts, because it's only needed by this reporting path, not by
// every process that imports env.ts (e.g. scripts/bootstrap-guild.ts).
const OperationalErrorsEnvSchema = z.object({
  STAFF_OPS_CHANNEL_ID: z.string().min(1).optional(),
});
const operationalErrorsEnv = OperationalErrorsEnvSchema.parse(process.env);

function safeLog(value: unknown) {
  try { console.error(JSON.stringify(value)); } catch { /* The reporter must never replace the original failure. */ }
}

function operationalDetails(error: Error): OperationalDetails | undefined {
  const candidate = error as Error & {
    operationalCode?: unknown;
    operationalSummary?: unknown;
    operationalNext?: unknown;
    operationalNoChanges?: unknown;
  };
  if (typeof candidate.operationalCode !== 'string'
    || typeof candidate.operationalSummary !== 'string'
    || typeof candidate.operationalNext !== 'string') return undefined;
  if (!/^[A-Z0-9][A-Z0-9_.-]{0,79}$/.test(candidate.operationalCode)) return undefined;
  return {
    code: candidate.operationalCode,
    summary: redactOperationalText(candidate.operationalSummary).replace(/[\r\n]/g, ' ').slice(0, 300),
    next: redactOperationalText(candidate.operationalNext).replace(/[\r\n]/g, ' ').slice(0, 300),
    noChanges: candidate.operationalNoChanges === true,
  };
}

export async function getValidatedStaffChannel(client: Client, db: Database.Database, guildId: string): Promise<GuildTextBasedChannel> {
  const row = getActiveManagedResourceByLogicalKey(db, guildId, serverChannelLogicalKey('admin', 'staff_ops', 'text_channel'));
  const managedChannelId = row && row.resourceType === 'text_channel' && row.scaffoldDomain === 'server' ? row.discordResourceId : undefined;
  // Fall back to the env var below when the channel isn't (yet) a managed
  // resource -- see OperationalErrorsEnvSchema above.
  const channelId = managedChannelId ?? operationalErrorsEnv.STAFF_OPS_CHANNEL_ID;
  if (!channelId) throw new Error('staff-ops is not managed');
  const channel = await client.channels.fetch(channelId, { force: true });
  if (!channel || channel.type !== ChannelType.GuildText || channel.guild.id !== guildId) throw new Error('staff-ops channel is unavailable or belongs to another guild');
  const guild = channel.guild;
  await guild.roles.fetch();
  // Production is the stable managed identity for the live Norns role. Its
  // Discord display name may change, but its stored resource ID remains the
  // authority for the intentional staff-ops access granted by league admins.
  const staffIds = new Set(['allfather', 'aesir', 'valkyries', 'production'].flatMap((key) => {
    const role = getActiveManagedResourceByLogicalKey(db, guildId, serverRoleLogicalKey(key));
    return role?.resourceType === 'role' ? [role.discordResourceId] : [];
  }));
  staffIds.add(LEGACY_YSL_VALKYRIE_ROLE_ID);
  for (const id of [process.env.ROLE_ALLFATHER_ID, process.env.ROLE_AESIR_ID, process.env.ROLE_VALKYRIE_ID?.trim()])
    if (id) staffIds.add(id);
  if (channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel, false)) throw new Error('staff-ops is public');
  const bot = guild.members.me ?? await guild.members.fetchMe();
  if (!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new Error('bot cannot send to staff-ops');
  }
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.id || staffIds.has(role.id) || role.permissions.has(PermissionFlagsBits.Administrator)
      || (role.managed && role.tags?.botId === client.user?.id)) continue;
    // Bot roles are not a justification for letting ordinary members read logs.
    if (channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel, false)) {
      throw new Error(`staff-ops permits a non-staff role: ${role.name} (${role.id})`);
    }
  }
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (overwrite.type !== 1 || !overwrite.allow.has(PermissionFlagsBits.ViewChannel) || overwrite.id === bot.id) continue;
    const member = await guild.members.fetch(overwrite.id);
    if (!member.permissions.has(PermissionFlagsBits.Administrator) && !member.roles.cache.some((role) => staffIds.has(role.id))) {
      throw new Error('staff-ops permits a non-staff member');
    }
  }
  return channel;
}

async function staffReportExists(
  channel: GuildTextBasedChannel,
  botUserId: string | undefined,
  reference: string,
): Promise<boolean> {
  if (!botUserId) return false;
  const expectedNonce = createHash('sha256').update(reference).digest('hex').slice(0, 24);
  let before: string | undefined;
  while (true) {
    const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const match = messages.some((message) => message.author.id === botUserId
      && (String(message.nonce ?? '') === expectedNonce
        || message.content.split(/\r?\n/).includes(`Reference: ${reference}`)));
    if (match) return true;
    if (messages.size < 100) return false;
    const oldest = messages.last();
    if (!oldest || oldest.id === before) return false;
    before = oldest.id;
  }
}

/** Concise safe Discord summary; redacted error detail stays in process logs. */
export async function reportOperationalError(
  client: Client,
  db: Database.Database,
  context: OperationContext,
  error: unknown,
  options?: { reference: string; retryUndelivered: true },
): Promise<Report> {
  const failure = error instanceof Error ? error : new Error(String(error));
  const code = (failure as Error & { code?: unknown }).code;
  const details = operationalDetails(failure);
  const failureIdentity = details
    ? createHash('sha256').update(JSON.stringify(details)).digest('hex')
    : String(code ?? '');
  const key = `${context.guildId}:${context.action}:${context.setupId ?? ''}:${failure.name}:${failureIdentity}:${options?.reference ?? ''}`;
  let records = recent.get(db);
  if (!records) { records = new Map(); recent.set(db, records); }
  const previous = records.get(key);
  const repeated = previous && Date.now() - previous.at < 60_000;
  const report = repeated ? previous : {
    reference: options?.reference ?? randomUUID(), staffDelivered: false, at: Date.now(), ...(details ? { details } : {}),
  };
  safeLog({ event: 'operation_failed', reference: report.reference, timestamp: new Date().toISOString(),
    context: { ...context, action: redactOperationalText(context.action), division: context.division ? redactOperationalText(context.division) : undefined,
      next: context.next ? redactOperationalText(context.next) : undefined },
    error: { name: redactOperationalText(failure.name), message: redactOperationalText(failure.message),
      stack: redactOperationalText(failure.stack ?? ''), code: redactOperationalText(String(code ?? '')),
      operationalCode: details?.code } });
  if (repeated && (report.staffDelivered || !options?.retryUndelivered)) {
    return { reference: report.reference, staffDelivered: report.staffDelivered, ...(report.details ? { details: report.details } : {}) };
  }
  if (records.size >= 200) records.delete(records.keys().next().value!);
  records.set(key, report); // Suppress ordinary duplicate alerts before the send.
  try {
    const channel = await getValidatedStaffChannel(client, db, context.guildId);
    if (options) {
      const bot = channel.guild.members.me ?? await channel.guild.members.fetchMe();
      if (!channel.permissionsFor(bot)?.has(PermissionFlagsBits.ReadMessageHistory)) {
        throw new Error('bot cannot read staff-ops history for durable alert recovery');
      }
      if (await staffReportExists(channel, client.user?.id, options.reference)) {
        report.staffDelivered = true;
        return { reference: report.reference, staffDelivered: true, ...(report.details ? { details: report.details } : {}) };
      }
    }
    const safe = (text: string) => escapeMarkdown(redactOperationalText(text).replace(/[\r\n]/g, ' ')).slice(0, 300);
    const failureLine = details
      ? `**What happened:** ${safe(details.summary)}`
      : [50001, 50013].includes(Number(code)) ? 'Discord denied access or permissions.'
        : [10003, 10008].includes(Number(code)) ? 'A required Discord channel or message is missing.'
          : 'Rat could not finish the action or confirm that its Discord post was sent.';
    const actionName = context.action.startsWith('/') ? context.action
      : context.action === 'League roster audit repair' ? 'fixing roster problems'
      : context.action === 'League roster audit review' ? 'reviewing roster problems'
      : /scout|inhouse/i.test(context.action) ? 'updating the game'
      : /league|roster|transaction|account/i.test(context.action) ? 'updating the league records'
      : 'that action';
    await channel.send({ content: [
      `Ratatoskr could not finish **${safe(actionName)}**.`,
      failureLine,
      details?.noChanges ? '**Changes:** No changes were made.' : '',
      context.setupId ? `Game #${context.setupId}${context.division ? ` (${safe(context.division)})` : ''}` : '',
      `Time: ${new Date().toISOString()}`,
      details ? `**What to do:** ${safe(details.next)}`
        : /reconciliation/i.test(context.action)
          ? 'Check Discord roles, both roster sheets and the transaction post/history. Some changes may already have happened. Do not retry the command until they agree.'
          : 'Check the saved action and current records or posts before trying anything again. Some changes may already have happened.',
      `Reference: ${report.reference}`,
    ].filter(Boolean).join('\n'), allowedMentions: { parse: [] },
      ...(options ? { nonce: createHash('sha256').update(options.reference).digest('hex').slice(0, 24), enforceNonce: true } : {}),
    });
    report.staffDelivered = true;
  } catch (deliveryError) {
    safeLog({ event: 'staff_report_unavailable', reference: report.reference,
      reason: redactOperationalText(deliveryError instanceof Error ? deliveryError.message : String(deliveryError)) });
  }
  return { reference: report.reference, staffDelivered: report.staffDelivered, ...(report.details ? { details: report.details } : {}) };
}

export function operationalErrorGuidance(report: Report): string {
  const delivery = report.staffDelivered
    ? `Staff were notified in staff-ops. Reference: ${report.reference}.`
    : `Rat could not confirm that staff were notified. Give staff reference ${report.reference} if you need help.`;
  if (!report.details) return `Rat could not confirm the action finished. Check the saved action or posts with staff before trying again. ${delivery}`;
  return [
    `What happened: ${report.details.summary}`,
    report.details.noChanges ? 'Changes: No changes were made.' : '',
    `What to do: ${report.details.next}`,
    delivery,
  ].filter(Boolean).join('\n');
}
