import { MessageFlags, type Interaction } from 'discord.js';
import type Database from 'better-sqlite3';
import { reportOperationalError, operationalErrorGuidance, type OperationContext } from './operationalErrors.js';

export function interactionOperationContext(interaction: Interaction, fallbackGuildId: string): OperationContext {
  const context: OperationContext = { guildId: interaction.guildId ?? fallbackGuildId, action: 'Discord interaction' };
  if (interaction.isChatInputCommand()) {
    context.action = `/${interaction.commandName}${interaction.options.getSubcommand(false) ? ` ${interaction.options.getSubcommand(false)}` : ''}`;
    return context;
  }
  if (!('customId' in interaction)) return context;
  const [prefix, operation = '', detail = '', nestedSetupId] = interaction.customId.split(':');
  if (prefix !== 'scout') return context;
  context.action = 'Scout interaction';
  let rawSetupId: string | undefined;
  if (['edit', 'editpick', 'edituser'].includes(operation)) {
    context.action = `Scout ${operation} ${detail}`;
    rawSetupId = nestedSetupId;
  } else if (['review', 'shuffle', 'buildtwo', 'buildtwoconfirm', 'buildtwoback',
    'publish', 'publishconfirm', 'publishback', 'publishedreplace', 'publishedswap',
    'publishedpick', 'publishedswapfirst', 'publishedswapsecond', 'publisheduser',
    'cancel', 'cancelconfirm', 'cancelkeep'].includes(operation)) {
    context.action = `Scout ${operation}`;
    rawSetupId = detail;
  } else if (operation === 'cancelpick') {
    context.action = 'Scout cancellation selection';
    // Legacy values contain only setup ID; current values include its version.
    rawSetupId = 'values' in interaction ? interaction.values[0]?.split(':')[0] : undefined;
  } else if (operation === 'cancelpage') context.action = 'Scout cancellation page';
  else if (operation === 'create') context.action = `Scout creation ${detail}`;
  const setupId = Number(rawSetupId);
  if (Number.isSafeInteger(setupId) && setupId > 0) context.setupId = setupId;
  return context;
}

export async function handleInteractionError(interaction: Interaction, db: Database.Database, error: unknown, fallbackGuildId: string): Promise<void> {
  const repliable = interaction.isRepliable() ? interaction : undefined;
  let deferredHere = false;
  if (repliable && !repliable.replied && !repliable.deferred) {
    // Staff validation can make several Discord calls. Reserve the private reply
    // before that work; an expired token must still produce an operational log.
    try { await repliable.deferReply({ flags: MessageFlags.Ephemeral }); deferredHere = true; }
    catch { /* Best effort acknowledgement; continue reporting the original error. */ }
  }
  const report = await reportOperationalError(interaction.client, db, interactionOperationContext(interaction, fallbackGuildId), error);
  if (!repliable) return;
  const payload = { content: `Ratatoskr could not complete that action. ${operationalErrorGuidance(report)}`, flags: MessageFlags.Ephemeral } as const;
  // A failed apology must never escape the event boundary. Existing component
  // acknowledgements get a private follow-up, leaving public controls untouched.
  if (deferredHere) await repliable.editReply({ content: payload.content }).catch(() => undefined);
  else if (repliable.replied || repliable.deferred) await repliable.followUp(payload).catch(() => undefined);
  else await repliable.reply(payload).catch(() => undefined);
}
