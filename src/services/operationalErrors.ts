import { createHash, randomUUID } from 'node:crypto';
import { ChannelType, PermissionFlagsBits, escapeMarkdown, type Client, type GuildTextBasedChannel } from 'discord.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getActiveManagedResourceByLogicalKey } from '../db/index.js';
import { serverChannelLogicalKey, serverRoleLogicalKey } from './serverBootstrap.js';

export type OperationContext = { guildId: string; action: string; setupId?: number; division?: string; next?: string };
type Report = { reference: string; staffDelivered: boolean };
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

export function redactOperationalText(value: string): string {
  let result = value;
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 4 && /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL/i.test(name)) {
      result = result.replaceAll(secret, '[REDACTED]');
    }
  }
  return result.replace(/(https?:\/\/|postgres(?:ql)?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(authorization[=: ]+(?:bot|bearer)?\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function safeLog(value: unknown) {
  try { console.error(JSON.stringify(value)); } catch { /* The reporter must never replace the original failure. */ }
}

async function validatedStaffChannel(client: Client, db: Database.Database, guildId: string): Promise<GuildTextBasedChannel> {
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
  const staffIds = new Set(['allfather', 'aesir', 'valkyries'].flatMap((key) => {
    const role = getActiveManagedResourceByLogicalKey(db, guildId, serverRoleLogicalKey(key));
    return role?.resourceType === 'role' ? [role.discordResourceId] : [];
  }));
  for (const id of [process.env.ROLE_ALLFATHER_ID, process.env.ROLE_AESIR_ID]) if (id) staffIds.add(id);
  if (channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel, false)) throw new Error('staff-ops is public');
  const bot = guild.members.me ?? await guild.members.fetchMe();
  if (!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) throw new Error('bot cannot send to staff-ops');
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.id || staffIds.has(role.id) || role.permissions.has(PermissionFlagsBits.Administrator)
      || (role.managed && role.tags?.botId === client.user?.id)) continue;
    // Bot roles are not a justification for letting ordinary members read logs.
    if (channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel, false)) throw new Error('staff-ops permits a non-staff role');
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
  const key = `${context.guildId}:${context.action}:${context.setupId ?? ''}:${failure.name}:${String(code ?? '')}:${options?.reference ?? ''}`;
  let records = recent.get(db);
  if (!records) { records = new Map(); recent.set(db, records); }
  const previous = records.get(key);
  const repeated = previous && Date.now() - previous.at < 60_000;
  const report = repeated ? previous : { reference: options?.reference ?? randomUUID(), staffDelivered: false, at: Date.now() };
  safeLog({ event: 'operation_failed', reference: report.reference, timestamp: new Date().toISOString(),
    context: { ...context, action: redactOperationalText(context.action), division: context.division ? redactOperationalText(context.division) : undefined,
      next: context.next ? redactOperationalText(context.next) : undefined },
    error: { name: redactOperationalText(failure.name), message: redactOperationalText(failure.message),
      stack: redactOperationalText(failure.stack ?? ''), code: redactOperationalText(String(code ?? '')) } });
  if (repeated && (report.staffDelivered || !options?.retryUndelivered)) {
    return { reference: report.reference, staffDelivered: report.staffDelivered };
  }
  if (records.size >= 200) records.delete(records.keys().next().value!);
  records.set(key, report); // Suppress ordinary duplicate alerts before the send.
  try {
    const channel = await validatedStaffChannel(client, db, context.guildId);
    const safe = (text: string) => escapeMarkdown(redactOperationalText(text).replace(/[\r\n]/g, ' ')).slice(0, 300);
    await channel.send({ content: [
      `Ratatoskr could not finish **${safe(context.action)}**.`,
      [50001, 50013].includes(Number(code)) ? 'Discord denied access or permissions.'
        : [10003, 10008].includes(Number(code)) ? 'A required Discord channel or message is missing.'
          : 'The operation failed or could not confirm Discord delivery.',
      context.setupId ? `Setup #${context.setupId}${context.division ? ` (${safe(context.division)})` : ''}` : '',
      `Time: ${new Date().toISOString()}`,
      safe(context.next ?? 'Review the matching Railway log and current setup state before retrying.'),
      `Reference: ${report.reference}`,
    ].filter(Boolean).join('\n'), allowedMentions: { parse: [] },
      ...(options ? { nonce: createHash('sha256').update(options.reference).digest('hex').slice(0, 24), enforceNonce: true } : {}),
    });
    report.staffDelivered = true;
  } catch (deliveryError) {
    safeLog({ event: 'staff_report_unavailable', reference: report.reference,
      reason: redactOperationalText(deliveryError instanceof Error ? deliveryError.message : String(deliveryError)) });
  }
  return { reference: report.reference, staffDelivered: report.staffDelivered };
}

export function operationalErrorGuidance(report: Report): string {
  return report.staffDelivered
    ? `Staff were notified in staff-ops. Reference: ${report.reference}.`
    : `The staff report could not be confirmed. Ask a bot operator to check Railway logs with reference ${report.reference}.`;
}
