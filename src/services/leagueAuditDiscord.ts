import { forgetMissingLeaguePanel } from '../db/repositories/leagueAudits.js';
import { createHash } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Client,
} from 'discord.js';
import type Database from 'better-sqlite3';
import { getValidatedStaffChannel } from './operationalErrors.js';
import type { LeagueAuditCardPort } from './leagueAudit.js';

function nonceFor(reference: string): string {
  return createHash('sha256').update(reference).digest('hex').slice(0, 24);
}

export function isResolvedLeagueAlertMessage(
  message: { author: { id: string }; content: string },
  botUserId: string | undefined,
  references: ReadonlySet<string>,
): boolean {
  if (!botUserId || message.author.id !== botUserId || !message.content.startsWith('Ratatoskr could not finish **')) return false;
  const reference = message.content.match(/^Reference: (\S+)\s*$/m)?.[1];
  return Boolean(reference && references.has(reference));
}

export function isLegacyResolvedLeagueAlertMessage(
  message: { author: { id: string }; content: string; createdTimestamp: number },
  botUserId: string | undefined,
  verifiedBefore: string,
): boolean {
  return Boolean(botUserId && message.author.id === botUserId && message.createdTimestamp < Date.parse(verifiedBefore)
    && /^Ratatoskr could not finish \*\*League roster audit (repair|review)\*\*\./.test(message.content)
    && /^Reference: [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\s*$/mi.test(message.content));
}

export function createLeagueAuditCardPort(
  client: Client,
  db: Database.Database,
  guildId: string,
): LeagueAuditCardPort {
  return {
    async deleteLegacyResolvedAlerts(verifiedBefore) {
      const channel = await getValidatedStaffChannel(client, db, guildId);
      const bot = channel.guild.members.me ?? await channel.guild.members.fetchMe();
      if (!channel.permissionsFor(bot)?.has(PermissionFlagsBits.ReadMessageHistory))
        throw new Error('bot cannot read staff-ops history for legacy league alert cleanup');
      let before: string | undefined;
      while (true) {
        const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        for (const message of messages.values()) {
          if (!isLegacyResolvedLeagueAlertMessage(message, client.user?.id, verifiedBefore)) continue;
          try { await message.delete(); }
          catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === RESTJSONErrorCodes.UnknownMessage)) throw error;
          }
        }
        if (messages.size < 100) return;
        const oldest = messages.last();
        if (!oldest || oldest.id === before) throw new Error('Legacy league alert cleanup could not advance history pagination');
        before = oldest.id;
      }
    },
    async deleteResolvedAlerts(references) {
      const channel = await getValidatedStaffChannel(client, db, guildId);
      const bot = channel.guild.members.me ?? await channel.guild.members.fetchMe();
      if (!channel.permissionsFor(bot)?.has(PermissionFlagsBits.ReadMessageHistory))
        throw new Error('bot cannot read staff-ops history for resolved league alert cleanup');
      const resolved = new Set(references);
      let before: string | undefined;
      while (true) {
        const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        for (const message of messages.values()) {
          if (!isResolvedLeagueAlertMessage(message, client.user?.id, resolved)) continue;
          try { await message.delete(); }
          catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === RESTJSONErrorCodes.UnknownMessage)) throw error;
          }
        }
        if (messages.size < 100) return;
        const oldest = messages.last();
        if (!oldest || oldest.id === before) throw new Error('Resolved league alert cleanup could not advance history pagination');
        before = oldest.id;
      }
    },
    async findByReference(reference) {
      const channel = await getValidatedStaffChannel(client, db, guildId);
      const bot = channel.guild.members.me ?? await channel.guild.members.fetchMe();
      if (!channel.permissionsFor(bot)?.has(PermissionFlagsBits.ReadMessageHistory)) {
        throw new Error('bot cannot read staff-ops history for league audit recovery');
      }
      const expectedNonce = nonceFor(reference);
      let before: string | undefined;
      while (true) {
        const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        const match = messages.find((message) => message.author.id === client.user?.id
          && (String(message.nonce ?? '') === expectedNonce || message.embeds.some(embed => embed.footer?.text.endsWith(reference))));
        if (match) return match.id;
        if (messages.size < 100) return undefined;
        const oldest = messages.last();
        if (!oldest || oldest.id === before) return undefined;
        before = oldest.id;
      }
    },
    async send(card, reference) {
      const channel = await getValidatedStaffChannel(client, db, guildId);
      const message = await channel.send({
        embeds: [new EmbedBuilder()
          .setTitle(card.title)
          .setDescription(card.description.slice(0, 4096))
          .setFooter({ text: `${card.footer} • ${reference}`.slice(0, 2048) })
          .setColor(0xC43C35)],
        components: card.actions?.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
          card.actions.map((action) => new ButtonBuilder()
            .setCustomId(`${action.id}:${reference}`)
            .setLabel(action.label)
            .setStyle(ButtonStyle.Primary)),
        )] : [],
        allowedMentions: { parse: [] },
        nonce: nonceFor(reference),
        enforceNonce: true,
      });
      return message.id;
    },
    async edit(messageId, card, reference) {
      const channel = await getValidatedStaffChannel(client, db, guildId);
      try {
        await channel.messages.edit(messageId, {
          embeds: [new EmbedBuilder().setTitle(card.title).setDescription(card.description.slice(0,4096)).setFooter({text:`${card.footer} • ${reference}`.slice(0,2048)}).setColor(card.description.includes('Status: Healthy') ? 0x358653 : 0xC43C35)],
          components: card.actions?.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(card.actions.map(action => new ButtonBuilder().setCustomId(`${action.id}:${reference}`).setLabel(action.label).setStyle(ButtonStyle.Primary)))] : [],
          allowedMentions: {parse:[]},
        });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === RESTJSONErrorCodes.UnknownMessage) {
          forgetMissingLeaguePanel(db,guildId,messageId);
        }
        throw error;
      }
    },
    async delete(messageId) {
      const channel = await getValidatedStaffChannel(client, db, guildId);
      try {
        await channel.messages.delete(messageId);
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === RESTJSONErrorCodes.UnknownMessage) return;
        throw error;
      }
    },
  };
}
